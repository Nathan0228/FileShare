package gateway

import (
	"context"
	"encoding/hex"
	"encoding/json"

	"sft/internal/auth"
	"sft/internal/transfer"
	"sft/internal/wire"
)

func (c *connection) authentication(ctx context.Context, m wire.Message) (wire.Message, error) {
	if m.Kind != wire.Logout && !c.gateway.limiter.permit("auth-ip:"+c.ip.String(), 36) {
		return wire.Message{}, wire.E("RATE_LIMIT", true)
	}
	service := c.gateway.auth
	switch m.Kind {
	case wire.EnrollBegin:
		var req struct {
			InviteToken string `json:"inviteToken"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		challenge, err := service.EnrollBegin(ctx, c.login, req.InviteToken)
		return jsonReply(m, wire.Challenge, challenge), err
	case wire.AuthBegin:
		var req struct {
			Username string `json:"username"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		if len(req.Username) == 0 || len(req.Username) > 64 {
			return wire.Message{}, wire.E("BAD_REQUEST", false)
		}
		if !c.gateway.limiter.permit("auth-user:"+req.Username, 12) {
			return wire.Message{}, wire.E("RATE_LIMIT", true)
		}
		challenge, err := service.LoginBegin(ctx, c.login, req.Username)
		return jsonReply(m, wire.Challenge, challenge), err
	case wire.EnrollFinish, wire.AuthFinish:
		var req struct {
			ChallengeID string          `json:"challengeId"`
			Credential  json.RawMessage `json:"credential"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		if req.ChallengeID == "" || len(req.Credential) == 0 || req.Credential[0] != '{' {
			return wire.Message{}, wire.E("BAD_REQUEST", false)
		}
		if m.Kind == wire.EnrollFinish {
			return m.Reply(wire.OK, nil), service.EnrollFinish(ctx, c.login, req.ChallengeID, req.Credential)
		}
		actor, err := service.LoginFinish(ctx, c.login, req.ChallengeID, req.Credential)
		return c.authenticated(m, actor, err)
	case wire.SessionAttach:
		var req struct {
			Token string `json:"token"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		actor, err := service.Attach(ctx, c.login, req.Token)
		return c.authenticated(m, actor, err)
	case wire.Logout:
		if err := service.Logout(ctx, c.login); err != nil {
			return wire.Message{}, err
		}
		c.workers.Wait()
		c.detach()
		return m.Reply(wire.OK, nil), nil
	}
	return wire.Message{}, wire.E("BAD_REQUEST", false)
}

func (c *connection) authenticated(m wire.Message, actor auth.Identity, err error) (wire.Message, error) {
	if err != nil {
		return wire.Message{}, err
	}
	if err := c.activate(actor); err != nil {
		return wire.Message{}, err
	}
	return jsonReply(m, wire.AuthOK, struct {
		UserID      wire.ID  `json:"userId"`
		Role        string   `json:"role"`
		Permissions []string `json:"permissions"`
		Token       string   `json:"token"`
	}{actor.UserID, actor.Role, permissions(actor.Permissions), actor.Token}), nil
}

func permissions(bits uint8) []string {
	names := make([]string, 0, 3)
	for i, name := range []string{"UPLOAD", "DOWNLOAD", "SHARE"} {
		if bits&(1<<i) != 0 {
			names = append(names, name)
		}
	}
	return names
}

func (c *connection) control(ctx context.Context, m wire.Message, actor auth.Identity) (wire.Message, error) {
	ok := m.Reply(wire.OK, nil)
	user := actor.UserID
	switch m.Kind {
	case wire.UserProfile:
		profile, err := c.gateway.store.Profile(ctx, user)
		return jsonReply(m, wire.UserProfileOK, profile), err
	case wire.OutgoingShares:
		var req struct {
			View   string  `json:"view"`
			Cursor *string `json:"cursor"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		page, err := c.gateway.store.OutgoingShares(ctx, user, req.View, req.Cursor)
		return jsonReply(m, wire.OutgoingSharesOK, page), err
	case wire.List:
		var req struct {
			Scope  string  `json:"scope"`
			Cursor *string `json:"cursor"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		page, err := c.gateway.store.List(ctx, user, req.Scope, req.Cursor)
		return jsonReply(m, wire.ListOK, page), err
	case wire.ShareSet:
		var req struct {
			FileID  wire.ID `json:"fileId"`
			Grantee string  `json:"grantee"`
			Allow   *bool   `json:"allow"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		if req.FileID == (wire.ID{}) || req.Allow == nil {
			return wire.Message{}, wire.E("BAD_REQUEST", false)
		}
		return ok, c.gateway.store.ShareSet(ctx, user, req.FileID, req.Grantee, *req.Allow)
	case wire.Admin:
		result, err := c.gateway.store.Admin(ctx, user, m.Body)
		return jsonReply(m, wire.OK, result), err
	case wire.FileDelete, wire.GetBegin:
		var req struct {
			FileID wire.ID `json:"fileId"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		if req.FileID == (wire.ID{}) {
			return wire.Message{}, wire.E("BAD_REQUEST", false)
		}
		if m.Kind == wire.FileDelete {
			return ok, c.gateway.store.FileDelete(ctx, user, req.FileID)
		}
		ready, err := c.files.DownloadBegin(ctx, user, req.FileID)
		if err != nil {
			return wire.Message{}, err
		}
		reply := jsonReply(m, wire.GetReady, struct {
			Name       string `json:"name"`
			Size       uint64 `json:"size"`
			SHA256     string `json:"sha256"`
			ChunkBytes uint64 `json:"chunkBytes"`
		}{ready.Name, ready.Size, hex.EncodeToString(ready.SHA256[:]), ready.ChunkBytes})
		reply.TransferID = req.FileID
		return reply, nil
	case wire.PutBegin:
		return c.uploadBegin(ctx, m, user)
	case wire.PutStatus:
		state, err := c.files.UploadStatus(ctx, user, m.TransferID)
		return jsonReply(m, wire.PutState, struct {
			State  string   `json:"state"`
			Bitmap string   `json:"bitmap"`
			FileID *wire.ID `json:"fileId"`
		}{state.State, state.Bitmap, state.FileID}), err
	case wire.PutCancel:
		return ok, c.files.UploadCancel(ctx, user, m.TransferID)
	case wire.PutPause:
		return ok, c.files.UploadPause(ctx, user, m.TransferID)
	case wire.GetDone:
		var req struct {
			SHA256 string `json:"sha256"`
		}
		if err := wire.JSON(m.Body, &req); err != nil {
			return wire.Message{}, err
		}
		digest, err := wire.ParseSHA256(req.SHA256)
		if err != nil {
			return wire.Message{}, err
		}
		return ok, c.files.DownloadDone(ctx, user, m.TransferID, digest)
	case wire.GetClose:
		return ok, c.files.DownloadClose(ctx, user, m.TransferID)
	}
	return wire.Message{}, wire.E("BAD_REQUEST", false)
}

func (c *connection) uploadBegin(ctx context.Context, m wire.Message, user wire.ID) (wire.Message, error) {
	var req struct {
		OpID   wire.ID `json:"opId"`
		Name   string  `json:"name"`
		Size   *uint64 `json:"size"`
		SHA256 string  `json:"sha256"`
	}
	if err := wire.JSON(m.Body, &req); err != nil {
		return wire.Message{}, err
	}
	if req.Size == nil || req.OpID == (wire.ID{}) {
		return wire.Message{}, wire.E("BAD_REQUEST", false)
	}
	digest, err := wire.ParseSHA256(req.SHA256)
	if err != nil {
		return wire.Message{}, err
	}
	ready, err := c.files.UploadBegin(ctx, user, transfer.UploadRequest{OpID: req.OpID, Name: req.Name, Size: *req.Size, SHA256: digest})
	if err != nil {
		return wire.Message{}, err
	}
	reply := jsonReply(m, wire.PutReady, struct {
		Size       uint64 `json:"size"`
		SHA256     string `json:"sha256"`
		ChunkBytes uint64 `json:"chunkBytes"`
		State      string `json:"state"`
	}{ready.Size, hex.EncodeToString(ready.SHA256[:]), ready.ChunkBytes, ready.State})
	reply.TransferID = ready.ID
	return reply, nil
}

func (c *connection) data(ctx context.Context, m wire.Message, actor auth.Identity, token string, files *transfer.Conn) (outgoing, error) {
	current, err := c.gateway.auth.CheckToken(ctx, token)
	if err := sameActor(current, actor.UserID, err); err != nil {
		return outgoing{}, err
	}
	user := actor.UserID
	switch m.Kind {
	case wire.PutData:
		digest := [wire.DigestSize]byte(m.Body[:wire.DigestSize])
		err := files.UploadChunk(ctx, user, m.TransferID, m.ChunkIndex, digest, m.Body[wire.DigestSize:])
		return outgoing{message: m.Reply(wire.OK, nil)}, err
	case wire.PutCommit:
		fileID, err := files.UploadCommit(ctx, user, m.TransferID)
		return outgoing{message: jsonReply(m, wire.PutDone, struct {
			FileID wire.ID `json:"fileId"`
		}{fileID})}, err
	case wire.GetChunk:
		digest, chunk, err := files.DownloadChunk(ctx, user, m.TransferID, m.ChunkIndex)
		if err != nil {
			return outgoing{}, err
		}
		body := make([]byte, wire.DigestSize+len(chunk))
		copy(body, digest[:])
		copy(body[wire.DigestSize:], chunk)
		return outgoing{message: m.Reply(wire.GetData, body), guard: func(ctx context.Context) error {
			current, err := c.gateway.auth.CheckToken(ctx, token)
			if err := sameActor(current, user, err); err != nil {
				return err
			}
			return files.CheckDownload(ctx, user, m.TransferID)
		}}, nil
	}
	return outgoing{}, wire.E("BAD_REQUEST", false)
}

func jsonReply(request wire.Message, kind wire.Kind, data any) wire.Message {
	if data == nil {
		return request.Reply(kind, nil)
	}
	body, err := json.Marshal(data)
	if err != nil || len(body) > wire.MaxControl {
		return request.Reply(wire.Err, []byte(`{"code":"STORAGE_UNAVAILABLE","retryable":true}`))
	}
	return request.Reply(kind, body)
}
