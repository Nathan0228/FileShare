CREATE TABLE IF NOT EXISTS share_contacts (
    sender_id BINARY(16) NOT NULL,
    recipient_id BINARY(16) NOT NULL,
    PRIMARY KEY (sender_id, recipient_id),
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (recipient_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS friend_notes (
    user_id BINARY(16) NOT NULL,
    friend_id BINARY(16) NOT NULL,
    note VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (user_id, friend_id),
    FOREIGN KEY (user_id, friend_id) REFERENCES share_contacts(sender_id, recipient_id)
) ENGINE=InnoDB;

INSERT INTO share_contacts (sender_id, recipient_id)
    SELECT DISTINCT f.owner_id, acl.grantee_id FROM file_acl acl
    JOIN files f ON f.id=acl.file_id
    WHERE f.owner_id<>acl.grantee_id
    ON DUPLICATE KEY UPDATE recipient_id=share_contacts.recipient_id;

INSERT INTO share_contacts (sender_id, recipient_id)
    SELECT DISTINCT a.actor_id, recipient.id FROM audit_events a
    JOIN users recipient ON recipient.username=
        CONVERT(JSON_UNQUOTE(JSON_EXTRACT(a.request_meta, '$.grantee')) USING ascii) COLLATE ascii_bin
    WHERE a.action='share.grant' AND a.result='OK' AND a.actor_id<>recipient.id
    ON DUPLICATE KEY UPDATE recipient_id=share_contacts.recipient_id;
