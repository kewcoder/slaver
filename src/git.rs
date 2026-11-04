//! Read-only git inspection over bare repos on disk, plus the repo path helper.
//! Push/pull transport lives in main.rs via `git http-backend` (CGI).

use serde_json::{json, Value};

fn bare(root: &str, repo_id: &str) -> Result<std::path::PathBuf, String> {
    if repo_id.is_empty() || repo_id.contains('/') || repo_id.contains('\0') || repo_id == "." || repo_id == ".." {
        return Err("Bad repo id.".to_string());
    }
    Ok(std::path::Path::new(root).join(format!("{repo_id}.git")))
}

async fn git(bare: &std::path::Path, args: &[&str]) -> Result<std::process::Output, String> {
    tokio::process::Command::new("git")
        .arg(format!("--git-dir={}", bare.display()))
        .args(args)
        .output()
        .await
        .map_err(|e| format!("git not available: {e}"))
}

pub fn repo_exists(root: &str, repo_id: &str) -> bool {
    bare(root, repo_id).map(|p| p.join("HEAD").exists()).unwrap_or(false)
}

pub async fn git_head_sha(root: &str, repo_id: &str) -> Result<Option<String>, String> {
    let b = bare(root, repo_id)?;
    if !b.join("HEAD").exists() {
        return Ok(None);
    }
    let out = git(&b, &["rev-parse", "HEAD"]).await?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

pub async fn git_branches(root: &str, repo_id: &str) -> Result<Vec<String>, String> {
    let b = bare(root, repo_id)?;
    if !b.join("HEAD").exists() {
        return Ok(vec![]);
    }
    let out = git(&b, &["branch", "--format=%(refname:short)"]).await?;
    if !out.status.success() {
        return Err(format!("git branch failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

pub async fn git_log(root: &str, repo_id: &str, limit: usize) -> Result<Vec<Value>, String> {
    let b = bare(root, repo_id)?;
    if !b.join("HEAD").exists() {
        return Ok(vec![]);
    }
    let out = git(&b, &["log", &format!("-n{}", limit.clamp(1, 100)), "--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s", "--date=iso"])
        .await?;
    if !out.status.success() {
        return Err(format!("git log failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(5, '\u{1f}');
            Some(json!({
                "sha": p.next().unwrap_or(""),
                "author": p.next().unwrap_or(""),
                "email": p.next().unwrap_or(""),
                "date": p.next().unwrap_or(""),
                "subject": p.next().unwrap_or(""),
            }))
        })
        .collect())
}

pub async fn git_show(root: &str, repo_id: &str, commit: &str) -> Result<String, String> {
    let b = bare(root, repo_id)?;
    if !b.join("HEAD").exists() {
        return Err("Repo is empty.".to_string());
    }
    let arg = if commit.trim().is_empty() {
        "HEAD".to_string()
    } else {
        let c = commit.trim();
        // Allow SHAs and branch names (passed as a single argv, never shelled).
        if c.len() > 128
            || !c
                .bytes()
                .all(|x| x.is_ascii_alphanumeric() || x == b'_' || x == b'-' || x == b'.' || x == b'/')
            || c.contains("..")
        {
            return Err("Bad commit or branch.".to_string());
        }
        c.to_string()
    };
    let out = git(&b, &["show", "--stat", "--patch", "--find-renames", &arg]).await?;
    if !out.status.success() {
        return Err(format!("git show failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.len() > 30_000 {
        text.truncate(30_000);
        text.push_str("\n… [truncated]");
    }
    Ok(text)
}

/// Files at HEAD with their blob sizes (path, bytes). Empty when the repo has no commits.
pub async fn git_tree_files(root: &str, repo_id: &str) -> Result<Vec<(String, u64)>, String> {
    let b = bare(root, repo_id)?;
    let out = git(&b, &["ls-tree", "-r", "-l", "-z", "HEAD"]).await?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    for entry in out.stdout.split(|c| *c == 0) {
        let line = String::from_utf8_lossy(entry);
        // "<mode> blob <sha> <size>\t<path>"
        let Some((meta, path)) = line.split_once('\t') else { continue };
        let parts: Vec<&str> = meta.split_whitespace().collect();
        if parts.get(1) != Some(&"blob") {
            continue;
        }
        let size = parts.get(3).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        files.push((path.to_string(), size));
    }
    Ok(files)
}

/// Text content of one file at HEAD (None when missing or not UTF-8).
pub async fn git_read_file(root: &str, repo_id: &str, path: &str) -> Result<Option<String>, String> {
    let b = bare(root, repo_id)?;
    let spec = format!("HEAD:{path}");
    let out = git(&b, &["show", &spec]).await?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8(out.stdout).ok())
}
