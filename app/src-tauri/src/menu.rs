use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{App, Runtime};

/// 安装桌面菜单。业务菜单项一律禁用，避免在工程骨架阶段出现假功能。
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "知行")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(
            &MenuItemBuilder::with_id("file.note.new", "新建笔记（占位）")
                .enabled(false)
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.task.new", "新建任务（占位）")
                .enabled(false)
                .build(app)?,
        )
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "视图").fullscreen().build()?;

    let help_menu = SubmenuBuilder::new(app, "帮助")
        .item(
            &MenuItemBuilder::with_id("help.docs", "使用说明（占位）")
                .enabled(false)
                .build(app)?,
        )
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &help_menu])
        .build()?;

    app.set_menu(menu)?;
    log::info!("menu installed: app / file / edit / view / help (business items disabled)");

    Ok(())
}
