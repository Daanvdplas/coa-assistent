//! Local operator utility for TypeScript ledger transactions; never exposed as a tool.
use std::fs::OpenOptions;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::process::Command;

pub fn run(args: &[String]) -> io::Result<i32> {
    let Some(separator) = args.iter().position(|arg| arg == "--") else {
        return Err(io::Error::other(
            "Usage: lock-exec PATH [--nonblocking] -- COMMAND [ARG ...]",
        ));
    };
    let nonblocking = match &args[..separator] {
        [_path] => false,
        [_path, flag] if flag == "--nonblocking" => true,
        _ => {
            return Err(io::Error::other(
                "Expected one lock path and optional --nonblocking",
            ));
        }
    };
    let command = args
        .get(separator + 1)
        .ok_or_else(|| io::Error::other("Missing locked command"))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&args[0])?;
    if !lock.metadata()?.is_file() {
        return Err(io::Error::other("Lock must be a regular file"));
    }
    let descriptor = lock.as_raw_fd();
    let flags = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
    if unsafe { libc::flock(descriptor, flags) } != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::WouldBlock {
            Ok(75)
        } else {
            Err(error)
        };
    }
    let mut child = Command::new(command);
    child.args(&args[separator + 2..]);
    child.env("COA_OPERATOR_LOCK_FD", descriptor.to_string());
    // The child shares this open-file description and therefore keeps the OS
    // lock even if the wrapper dies before its transaction has finished.
    unsafe {
        child.pre_exec(move || {
            let flags = libc::fcntl(descriptor, libc::F_GETFD);
            if flags == -1
                || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let status = child.status()?;
    // Do not explicitly flock(LOCK_UN): inherited descriptors may still be in
    // use by descendants. The OS releases the lock after the last close.
    drop(lock);
    use std::os::unix::process::ExitStatusExt;
    Ok(status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
}
