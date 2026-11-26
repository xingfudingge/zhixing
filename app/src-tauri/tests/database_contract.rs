//! P0-03 数据库验收契约（通过公开 API 跑真实 SQLite 文件）。

use std::path::{Path, PathBuf};

use tempfile::TempDir;
use zhixing_lib::db::{self, DB_FILE_NAME};
use zhixing_lib::repositories::events::{self as events_repo, EventUpdate, NewEvent};
use zhixing_lib::repositories::notes::{self as notes_repo, NewNote, NoteQuery};
use zhixing_lib::repositories::seed;
use zhixing_lib::repositories::tasks::{self as tasks_repo, NewTask, TaskQuery};
use zhixing_lib::repositories::{lists, Repository};

fn database() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("nested").join(DB_FILE_NAME);
    (dir, path)
}

fn count(path: &Path, table: &str) -> i64 {
    let connection = db::open_connection(path).expect("open database");
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count rows")
}

#[test]
fn empty_database_migrates_to_latest_with_wal_and_foreign_keys() {
    let (_dir, path) = database();
    assert!(!path.exists());

    let status = db::migrate_path(&path).expect("migrate empty database");
    assert!(status.ready);
    assert_eq!(status.schema_version, 7);
    assert_eq!(status.journal_mode, "wal");
    assert!(status.foreign_keys);
    assert_eq!(
        status.applied,
        vec![
            "0001_bootstrap".to_string(),
            "0002_domain".to_string(),
            "0003_review_snapshots".to_string(),
            "0004_event_calendar_type".to_string(),
            "0005_lists_parent".to_string(),
            "0006_note_encryption".to_string(),
            "0007_note_encryption_scrub".to_string()
        ]
    );
    assert!(path.exists());

    let required = [
        "lists",
        "tasks",
        "subtasks",
        "notes",
        "note_blocks",
        "note_todos",
        "events",
        "countdowns",
        "habits",
        "habit_logs",
        "focus_sessions",
        "boards",
        "board_nodes",
        "board_edges",
        "attachments",
        "settings",
        "review_snapshots",
    ];
    for table in required {
        assert!(count(&path, table) >= 0, "table {table} should exist");
    }
}

#[test]
fn repeated_migrate_is_idempotent_for_schema_and_seed() {
    let (_dir, path) = database();
    db::migrate_path(&path).expect("first migrate");

    let tables = [
        "lists",
        "tasks",
        "notes",
        "note_blocks",
        "boards",
        "board_nodes",
    ];
    let before: Vec<i64> = tables.iter().map(|table| count(&path, table)).collect();

    let second = db::migrate_path(&path).expect("second migrate");
    assert_eq!(second.schema_version, 7);
    assert_eq!(
        second.applied.len(),
        7,
        "status lists applied migrations, but they must not be applied twice"
    );

    let after: Vec<i64> = tables.iter().map(|table| count(&path, table)).collect();
    assert_eq!(before, after, "seed must not duplicate");

    let connection = db::open_connection(&path).expect("open");
    let migrations: i64 = connection
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .expect("migration count");
    assert_eq!(migrations, 7);
}

#[test]
fn seed_provides_inbox_work_and_samples() {
    let (_dir, path) = database();
    db::migrate_path(&path).expect("migrate");
    let repository = Repository::new(path);

    let lists = {
        let connection = repository.connection().expect("connection");
        lists::list(&connection, false).expect("lists")
    };
    assert!(lists.iter().any(|list| list.id == "inbox" && list.is_inbox));
    assert!(lists.iter().any(|list| list.id == "work" && !list.is_inbox));

    let connection = repository.connection().expect("connection");
    let tasks = tasks_repo::list(&connection, &TaskQuery::default()).expect("tasks");
    let notes = notes_repo::list(&connection, &NoteQuery::default()).expect("notes");
    assert!(tasks.iter().any(|task| task.id == seed::REVIEW_TASK_ID));
    assert!(notes.iter().any(|note| note.id == seed::WELCOME_NOTE_ID));
    assert!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
                [seed::BOARD_ID],
                |row| row.get::<_, i64>(0)
            )
            .expect("board")
            >= 1
    );
}

#[test]
fn lists_parent_column_and_tree_migration_contract() {
    let (_dir, path) = database();
    db::migrate_path(&path).expect("migrate");
    let repository = Repository::new(path);
    let connection = repository.connection().expect("connection");

    let column: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('lists') WHERE name = 'parent_id'",
            [],
            |row| row.get(0),
        )
        .expect("lists.parent_id column");
    assert_eq!(column, 1, "lists 必须有 parent_id 列");

    let inbox = lists::get(&connection, "inbox").expect("inbox");
    assert_eq!(inbox.parent_id, None);

    let child = lists::create(
        &connection,
        lists::NewList {
            id: Some("contract-child".to_string()),
            space_id: None,
            name: "合同子清单".to_string(),
            color: None,
            icon: None,
            parent_id: Some("work".to_string()),
            sort_order: None,
            is_inbox: Some(false),
        },
    )
    .expect("create child");
    assert_eq!(child.parent_id.as_deref(), Some("work"));

    let grandchild = lists::create(
        &connection,
        lists::NewList {
            id: Some("contract-grandchild".to_string()),
            space_id: None,
            name: "合同孙清单".to_string(),
            color: None,
            icon: None,
            parent_id: Some(child.id.clone()),
            sort_order: None,
            is_inbox: Some(false),
        },
    )
    .expect("create grandchild");
    let too_deep = lists::create(
        &connection,
        lists::NewList {
            id: None,
            space_id: None,
            name: "第四层".to_string(),
            color: None,
            icon: None,
            parent_id: Some(grandchild.id.clone()),
            sort_order: None,
            is_inbox: Some(false),
        },
    );
    assert!(too_deep.is_err(), "work → child → 孙 → 第四层必须被拒绝");

    let cycle = lists::move_list(
        &connection,
        "work",
        lists::ListMove {
            parent_id: Some(child.id.clone()),
            sort_order: 10.0,
        },
    );
    assert!(cycle.is_err(), "父清单不能移动到自己的子清单下");

    lists::validate_tree(&connection).expect("tree valid");
}

#[test]
fn deleting_parent_list_promotes_children_in_real_sqlite() {
    let (_dir, path) = database();
    db::migrate_path(&path).expect("migrate");
    let repository = Repository::new(path);
    let connection = repository.connection().expect("connection");

    let child = lists::create(
        &connection,
        lists::NewList {
            id: Some("contract-promote".to_string()),
            space_id: None,
            name: "待上移".to_string(),
            color: None,
            icon: None,
            parent_id: Some("work".to_string()),
            sort_order: None,
            is_inbox: Some(false),
        },
    )
    .expect("child");

    let result = lists::delete(&connection, "work").expect("delete work");
    assert_eq!(result.promoted_lists, 1);
    assert!(result.moved_tasks >= 1);
    let promoted = lists::get(&connection, &child.id).expect("promoted child");
    assert_eq!(promoted.parent_id, None);
    let inbox = lists::get(&connection, "inbox").expect("inbox");
    let moved: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE list_id = ?1 AND deleted_at IS NULL",
            [&inbox.id],
            |row| row.get(0),
        )
        .expect("count inbox tasks");
    assert!(moved >= result.moved_tasks as i64);
}

#[test]
fn events_carry_calendar_type_defaulting_to_solar() {
    let (_dir, path) = database();
    db::migrate_path(&path).expect("migrate");
    let repository = Repository::new(path);
    let connection = repository.connection().expect("connection");

    let column: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('events') WHERE name = 'calendar_type'",
            [],
            |row| row.get(0),
        )
        .expect("events.calendar_type column");
    assert_eq!(column, 1, "events 必须有 calendar_type 列");

    let solar = events_repo::create(
        &connection,
        NewEvent {
            id: Some("contract-event-solar".to_string()),
            space_id: None,
            title: "产品评审会".to_string(),
            event_type: None,
            all_day: None,
            start_date: "2026-11-01".to_string(),
            start_at: None,
            end_at: None,
            tz: None,
            source: None,
            external_uid: None,
            repeat_rule: None,
            calendar_type: None,
            note_id: None,
            color: None,
        },
    )
    .expect("create default event");
    assert_eq!(solar.calendar_type, "solar");

    let lunar = events_repo::create(
        &connection,
        NewEvent {
            id: Some("contract-event-lunar".to_string()),
            space_id: None,
            title: "农历生日".to_string(),
            event_type: Some("生日".to_string()),
            all_day: Some(true),
            start_date: "2026-11-01".to_string(),
            start_at: None,
            end_at: None,
            tz: None,
            source: None,
            external_uid: None,
            repeat_rule: Some("每年".to_string()),
            calendar_type: Some("lunar".to_string()),
            note_id: None,
            color: None,
        },
    )
    .expect("create lunar event");
    assert_eq!(lunar.calendar_type, "lunar");
    assert_eq!(lunar.start_date, "2026-11-01");

    let switched = events_repo::update(
        &connection,
        "contract-event-lunar",
        EventUpdate {
            title: lunar.title.clone(),
            event_type: lunar.event_type.clone(),
            all_day: lunar.all_day,
            start_date: lunar.start_date.clone(),
            start_at: lunar.start_at.clone(),
            end_at: lunar.end_at.clone(),
            tz: Some(lunar.tz.clone()),
            source: Some(lunar.source.clone()),
            external_uid: lunar.external_uid.clone(),
            repeat_rule: Some(lunar.repeat_rule.clone()),
            calendar_type: "solar".to_string(),
            note_id: lunar.note_id.clone(),
            color: Some(lunar.color.clone()),
        },
    )
    .expect("switch event back to solar");
    assert_eq!(switched.calendar_type, "solar");

    let invalid = events_repo::create(
        &connection,
        NewEvent {
            id: Some("contract-event-mayan".to_string()),
            space_id: None,
            title: "玛雅历".to_string(),
            event_type: None,
            all_day: None,
            start_date: "2026-11-01".to_string(),
            start_at: None,
            end_at: None,
            tz: None,
            source: None,
            external_uid: None,
            repeat_rule: None,
            calendar_type: Some("mayan".to_string()),
            note_id: None,
            color: None,
        },
    )
    .expect_err("unknown calendar type must be rejected");
    assert!(invalid.to_string().contains("历法类型无效"));
}

#[test]
fn foreign_keys_reject_orphans_and_soft_delete_hides_rows() {
    let (_dir, path) = database();
    db::migrate_path(&path).expect("migrate");
    let repository = Repository::new(path);
    let connection = repository.connection().expect("connection");

    let orphan_task = tasks_repo::create(
        &connection,
        NewTask {
            id: Some("contract-orphan-task".to_string()),
            space_id: None,
            list_id: "missing-list".to_string(),
            parent_id: None,
            note_id: None,
            title: "孤儿任务".to_string(),
            notes: None,
            status: None,
            priority: None,
            quadrant: None,
            due_date: None,
            due_time: None,
            due_at: None,
            tz: None,
            reminder: None,
            sort_order: None,
        },
    );
    assert!(orphan_task.is_err());
    assert!(orphan_task.unwrap_err().to_string().contains("FOREIGN KEY"));

    let orphan_note_block = connection.execute(
        "INSERT INTO note_blocks (id, note_id, block_type) VALUES ('orphan-block', 'missing', 'p')",
        [],
    );
    assert!(orphan_note_block.is_err());
    assert!(orphan_note_block
        .unwrap_err()
        .to_string()
        .contains("FOREIGN KEY"));

    let note = notes_repo::create(
        &connection,
        NewNote {
            id: Some("contract-note".to_string()),
            space_id: None,
            title: "合同测试笔记".to_string(),
            folder_id: None,
            tags: Some(vec!["测试".to_string()]),
            body: Some("<p>正文</p>".to_string()),
            body_format: None,
            status: None,
            favorite: None,
            pinned: None,
            encrypted: None,
            encrypted_tags_json: None,
        },
    )
    .expect("create note");

    let task = tasks_repo::create(
        &connection,
        NewTask {
            id: Some("contract-task".to_string()),
            space_id: None,
            list_id: "inbox".to_string(),
            parent_id: None,
            note_id: Some(note.id.clone()),
            title: "关联笔记的任务".to_string(),
            notes: None,
            status: None,
            priority: None,
            quadrant: None,
            due_date: None,
            due_time: None,
            due_at: None,
            tz: None,
            reminder: None,
            sort_order: None,
        },
    )
    .expect("create task");
    assert_eq!(task.note_id.as_deref(), Some("contract-note"));

    notes_repo::delete(&connection, &note.id).expect("soft delete note");
    assert!(matches!(
        notes_repo::get(&connection, &note.id),
        Err(zhixing_lib::repositories::RepoError::NotFound { .. })
    ));
    let active_notes = notes_repo::list(&connection, &NoteQuery::default()).expect("notes");
    assert!(!active_notes.iter().any(|item| item.id == note.id));
    let all_notes = notes_repo::list(
        &connection,
        &NoteQuery {
            include_deleted: Some(true),
            ..NoteQuery::default()
        },
    )
    .expect("all notes");
    assert!(all_notes.iter().any(|item| item.id == note.id));

    // 软删除不遗弃任务行，也不产生孤儿。
    assert!(tasks_repo::get(&connection, "contract-task").is_ok());
}
