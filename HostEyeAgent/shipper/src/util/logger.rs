// util/logger.rs
// Port từ: Services/FileLogger.cs

use chrono::Local;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};

pub struct FileLogger {
    path: String,
    lock: Mutex<()>,
}

impl FileLogger {
    pub fn new(path: &str) -> Self {
        if let Some(parent) = Path::new(path).parent() {
            let _ = fs::create_dir_all(parent);
        }
        Self {
            path: path.to_string(),
            lock: Mutex::new(()),
        }
    }

    pub fn info(&self, message: &str)  { self.write("INFO",  message); }
    pub fn warn(&self, message: &str)  { self.write("WARN",  message); }
    pub fn error(&self, message: &str) { self.write("ERROR", message); }

    fn write(&self, level: &str, message: &str) {
        let line = format!(
            "{} {} {}\n",
            Local::now().format("%Y-%m-%d %H:%M:%S %z"),
            level,
            message
        );
        println!("{}", line.trim_end());

        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(parent) = Path::new(&self.path).parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}
