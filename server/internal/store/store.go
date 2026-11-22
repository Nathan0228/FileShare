// Package store maintains the relational data used by the SFT server.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	_ "embed"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

const (
	UploadPermission uint8 = 1 << iota
	DownloadPermission
	SharePermission
)

const adminQuotaBytes = 8 << 30

//go:embed schema.sql
var schema string

//go:embed friends.sql
var friendsMigration string

type Store struct {
	DB        *sql.DB
	cursorKey [32]byte
}

// Open configures UTC timestamps and connection limits before checking MariaDB connectivity.
func Open(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse MariaDB DSN: %w", err)
	}
	if cfg.DBName == "" {
		return nil, errors.New("MariaDB DSN must specify a database")
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.MultiStatements = false
	cfg.InterpolateParams = false
	cfg.AllowAllFiles = false
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	if cfg.Timeout == 0 {
		cfg.Timeout = 5 * time.Second
	}
	if cfg.ReadTimeout == 0 {
		cfg.ReadTimeout = 15 * time.Second
	}
	if cfg.WriteTimeout == 0 {
		cfg.WriteTimeout = 15 * time.Second
	}

	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, fmt.Errorf("configure MariaDB connection: %w", err)
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(32)
	db.SetMaxIdleConns(8)
	db.SetConnMaxIdleTime(3 * time.Minute)
	db.SetConnMaxLifetime(20 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect to MariaDB: %w", err)
	}
	return New(db), nil
}

func New(db *sql.DB) *Store {
	s := &Store{DB: db}
	// The key authenticates short-lived pagination cursors for this process.
	rand.Read(s.cursorKey[:])
	return s
}

// Migrate runs the versioned schema with a connection-scoped MariaDB lock.
func (s *Store) Migrate(ctx context.Context) error {
	return s.withLock(ctx, "sft:v1:migrate", func(conn *sql.Conn) error {
		if err := applyMigration(ctx, conn, 1, schema); err != nil {
			return err
		}
		var applied bool
		if err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=2)`).Scan(&applied); err != nil {
			return err
		}
		if applied {
			return nil
		}
		return applyMigration(ctx, conn, 2, friendsMigration)
	})
}

func applyMigration(ctx context.Context, conn *sql.Conn, version int, script string) error {
	for i, statement := range strings.Split(script, ";") {
		if statement = strings.TrimSpace(statement); statement == "" {
			continue
		}
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("apply MariaDB migration %d statement %d: %w", version, i+1, err)
		}
	}
	_, err := conn.ExecContext(ctx, `INSERT INTO schema_migrations (version)
		VALUES (?) ON DUPLICATE KEY UPDATE version=version`, version)
	return err
}

// withLock keeps the lock and the work on one connection. Named locks are
// automatically released if MariaDB disconnects that connection.
func (s *Store) withLock(ctx context.Context, name string, work func(*sql.Conn) error) error {
	conn, err := s.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	var locked sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, 10)", name).Scan(&locked); err != nil {
		return err
	}
	if !locked.Valid || locked.Int64 != 1 {
		return fmt.Errorf("could not acquire MariaDB lock %q", name)
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		var released sql.NullInt64
		err := conn.QueryRowContext(releaseCtx, "SELECT RELEASE_LOCK(?)", name).Scan(&released)
		if err != nil || !released.Valid || released.Int64 != 1 {
			// Discard the connection if explicit unlock fails, since a session
			// lock may otherwise remain owned by a pooled connection.
			conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	return work(conn)
}

// PruneAudit removes an indexed, bounded batch of events beyond retention.
func (s *Store) PruneAudit(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM audit_events
		WHERE created_at<? ORDER BY created_at LIMIT 1000`, time.Now().UTC().Add(-30*24*time.Hour))
	return err
}

func duplicate(err error) bool {
	var serverErr *mysql.MySQLError
	return errors.As(err, &serverErr) && serverErr.Number == 1062
}
