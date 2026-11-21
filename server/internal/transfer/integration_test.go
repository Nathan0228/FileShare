package transfer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"sft/internal/store"
	"sft/internal/wire"
)

// SFT_TRANSFER_TEST_DSN must point to a disposable MariaDB-compatible database.
func TestTransferRecoveryAndACL(t *testing.T) {
	dsn := os.Getenv("SFT_TRANSFER_TEST_DSN")
	if dsn == "" {
		t.Skip("SFT_TRANSFER_TEST_DSN is required for the database integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	st, err := store.Open(ctx, dsn)
	requireOK(t, err)
	defer st.DB.Close()
	requireOK(t, st.Migrate(ctx))

	writer, err := wire.NewID()
	requireOK(t, err)
	reader, err := wire.NewID()
	requireOK(t, err)
	for _, actor := range []wire.ID{writer, reader} {
		_, err := st.DB.ExecContext(ctx, `INSERT INTO users (id, username, role, enabled, permissions, quota_bytes)
			VALUES (?, ?, 'user', 1, 7, 16777216)`, actor[:], "test-"+actor.String())
		requireOK(t, err)
	}
	backend, err := New(st.DB, t.TempDir())
	requireOK(t, err)
	conn := backend.Conn("first")
	op, err := wire.NewID()
	requireOK(t, err)
	data := bytes.Repeat([]byte{0xde, 0xad, 0xbe, 0xef}, 600*1024/4)
	request := UploadRequest{OpID: op, Size: uint64(len(data)), SHA256: sha256.Sum256(data), Name: "file.bin"}
	job, err := conn.UploadBegin(ctx, writer, request)
	requireOK(t, err)

	put := func(conn *Conn, idx uint32) {
		start := int(idx) * ChunkBytes
		part := data[start:min(start+ChunkBytes, len(data))]
		requireOK(t, conn.UploadChunk(ctx, writer, job.ID, idx, sha256.Sum256(part), part))
	}
	put(conn, 0)
	put(conn, 2)
	conn.Close()
	conn = backend.Conn("resumed")
	defer conn.Close()
	state, err := conn.UploadStatus(ctx, writer, job.ID)
	requireOK(t, err)
	if state.Bitmap != "BQ" || state.State != "OPEN" {
		t.Fatalf("unexpected persisted bitmap: %+v", state)
	}
	put(conn, 1)
	put(conn, 1)

	// Emulate interruption after the final object was renamed but before its SQL transaction.
	_, err = st.DB.ExecContext(ctx, `UPDATE upload_jobs SET state='VERIFYING' WHERE id=?`, job.ID[:])
	requireOK(t, err)
	row, err := loadJob(ctx, st.DB, `id = ?`, job.ID[:])
	requireOK(t, err)
	requireOK(t, backend.assemble(ctx, row, filepath.Join(backend.objects, job.ID.String())))
	requireOK(t, backend.Recover(ctx))
	fileID, err := conn.UploadCommit(ctx, writer, job.ID)
	requireOK(t, err)
	state, err = conn.UploadStatus(ctx, writer, job.ID)
	requireOK(t, err)
	if state.State != "READY" || state.Bitmap != "Bw" || state.FileID == nil || *state.FileID != fileID {
		t.Fatalf("inconsistent recovered publication: %+v", state)
	}
	readerConn := backend.Conn("reader")
	defer readerConn.Close()
	_, err = readerConn.DownloadBegin(ctx, reader, fileID)
	requireCode(t, err, "DENIED")
	requireOK(t, st.ShareSet(ctx, writer, fileID, "test-"+reader.String(), true))
	manifest, err := readerConn.DownloadBegin(ctx, reader, fileID)
	requireOK(t, err)
	if manifest.SHA256 != request.SHA256 || manifest.Size != request.Size {
		t.Fatalf("published manifest differs from declaration: %+v", manifest)
	}
	digest, tail, err := readerConn.DownloadChunk(ctx, reader, fileID, 2)
	requireOK(t, err)
	if !bytes.Equal(tail, data[2*ChunkBytes:]) || digest != sha256.Sum256(tail) {
		t.Fatal("wrong data or digest for tail chunk")
	}
	for i := 0; i < 2; i++ {
		_, err := readerConn.DownloadBegin(ctx, reader, fileID)
		requireOK(t, err)
		requireOK(t, readerConn.DownloadDone(ctx, reader, fileID, request.SHA256))
	}
	var events int
	requireOK(t, st.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_events
		WHERE actor_id = ? AND target_id = ? AND action = 'download.complete'`, reader[:], fileID[:]).Scan(&events))
	if events != 1 {
		t.Fatalf("download acknowledged %d times in audit", events)
	}
	_, err = readerConn.DownloadBegin(ctx, reader, fileID)
	requireOK(t, err)
	requireOK(t, st.ShareSet(ctx, writer, fileID, "test-"+reader.String(), false))
	requireCode(t, readerConn.CheckDownload(ctx, reader, fileID), "DENIED")

	requireOK(t, st.FileDelete(ctx, writer, fileID))
	requireOK(t, backend.Cleanup(ctx))
	if _, err := os.Stat(filepath.Join(backend.objects, job.ID.String())); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted object still exists or could not be checked: %v", err)
	}
}

func requireOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var problem *wire.ProtocolError
	if !errors.As(err, &problem) || problem.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
