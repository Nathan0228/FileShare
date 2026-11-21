package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"sft/internal/auth"
	"sft/internal/gateway"
	"sft/internal/store"
	"sft/internal/transfer"

	"github.com/go-sql-driver/mysql"
)

func main() {
	level := slog.LevelInfo
	if os.Getenv("SFT_LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("sft exited", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	command := "serve"
	if len(args) != 0 {
		command, args = args[0], args[1:]
	}
	var username string
	switch command {
	case "serve", "migrate":
		if len(args) != 0 {
			return fmt.Errorf("%s does not accept arguments", command)
		}
	case "bootstrap":
		flags := flag.NewFlagSet("bootstrap", flag.ContinueOnError)
		flags.StringVar(&username, "username", "admin", "name of the first administrator")
		if err := flags.Parse(args); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("bootstrap accepts only --username")
		}
	case "help", "-h", "--help":
		fmt.Println("sft [serve | migrate | bootstrap --username NAME]")
		return nil
	default:
		return fmt.Errorf("unknown command %q; use sft help", command)
	}
	if err := configureDatabase(); err != nil {
		return err
	}
	initCtx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	db, err := store.Open(initCtx, databaseDSN())
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.DB.Close()
	if err := db.Migrate(initCtx); err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	switch command {
	case "migrate":
		return nil
	case "bootstrap":
		token, err := db.Bootstrap(initCtx, username)
		if err != nil {
			return fmt.Errorf("first administrator: %w", err)
		}
		// Bootstrap is an explicit operator action. Keep the invitation out of logs.
		fmt.Println(token)
		return nil
	}
	return serve(ctx, db)
}

func configureDatabase() error {
	if os.Getenv("SFT_DB_DSN") == "" && os.Getenv("SFT_DB_PASSWORD") == "" {
		return errors.New("set SFT_DB_PASSWORD or SFT_DB_DSN")
	}
	return nil
}

func databaseDSN() string {
	if dsn := os.Getenv("SFT_DB_DSN"); dsn != "" {
		return dsn
	}
	cfg := mysql.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = env("SFT_DB_ADDR", "127.0.0.1:3306")
	cfg.DBName = env("SFT_DB_NAME", "sft")
	cfg.User = env("SFT_DB_USER", "sft")
	cfg.Passwd = os.Getenv("SFT_DB_PASSWORD")
	return cfg.FormatDSN()
}

func serve(parent context.Context, db *store.Store) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	origin := env("SFT_ORIGIN", "http://localhost:5173")
	login, err := auth.New(db.DB, env("SFT_RP_ID", "localhost"), []string{origin})
	if err != nil {
		return fmt.Errorf("configure WebAuthn: %w", err)
	}
	trustProxy, err := strconv.ParseBool(env("SFT_TRUST_PROXY", "false"))
	if err != nil {
		return errors.New("SFT_TRUST_PROXY must be a boolean")
	}
	files, err := transfer.New(db.DB, env("SFT_STORAGE_ROOT", "./data"))
	if err != nil {
		return fmt.Errorf("open file storage: %w", err)
	}
	recovery, stopRecovery := context.WithTimeout(ctx, 5*time.Minute)
	err = files.Recover(recovery)
	stopRecovery()
	if err != nil {
		return fmt.Errorf("recover file storage: %w", err)
	}
	api := gateway.New(ctx, db, login, files, origin, trustProxy)
	listenerConfig := net.ListenConfig{KeepAliveConfig: net.KeepAliveConfig{
		Enable: true, Idle: 60 * time.Second, Interval: 15 * time.Second, Count: 4,
	}}
	listener, err := listenerConfig.Listen(ctx, "tcp", env("SFT_LISTEN_ADDR", "127.0.0.1:8080"))
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second,
		MaxHeaderBytes: 16 * 1024,
	}
	maintenance := make(chan struct{})
	go func() {
		defer close(maintenance)
		maintain(ctx, db, login, files)
	}()
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	slog.Info("sft listening", "address", listener.Addr(), "origin", origin)
	select {
	case <-ctx.Done():
	case err = <-serveErr:
	}
	cancel()
	drain, stopDrain := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopDrain()
	if shutdownErr := server.Shutdown(drain); shutdownErr != nil {
		_ = server.Close()
	}
	api.Wait()
	<-maintenance
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func maintain(ctx context.Context, db *store.Store, login *auth.Service, files *transfer.Service) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			cleanup, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := files.Cleanup(cleanup); err != nil && ctx.Err() == nil {
				slog.Warn("storage maintenance failed", "errorType", fmt.Sprintf("%T", err))
			}
			if err := login.Prune(cleanup); err != nil && ctx.Err() == nil {
				slog.Warn("session maintenance failed", "errorType", fmt.Sprintf("%T", err))
			}
			if err := db.PruneAudit(cleanup); err != nil && ctx.Err() == nil {
				slog.Warn("audit maintenance failed", "errorType", fmt.Sprintf("%T", err))
			}
			cancel()
		}
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
