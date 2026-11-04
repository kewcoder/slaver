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

async fn git_io(bare: &std::path::Path, args: &[&str], stdin: Option<&[u8]>, env: &[(&str, &str)]) -> Result<std::process::Output, String> {
    use tokio::io::AsyncWriteExt;
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg(format!("--git-dir={}", bare.display())).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.env("GIT_AUTHOR_NAME", "Slaver AI").env("GIT_AUTHOR_EMAIL", "ai@slaver.app").env("GIT_COMMITTER_NAME", "Slaver AI").env("GIT_COMMITTER_EMAIL", "ai@slaver.app");
    cmd.stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() });
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("git not available: {e}"))?;
    if let (Some(data), Some(mut sin)) = (stdin, child.stdin.take()) {
        sin.write_all(data).await.map_err(|e| e.to_string())?;
    }
    child.wait_with_output().await.map_err(|e| e.to_string())
}

fn ok_stdout(out: std::process::Output, what: &str) -> Result<String, String> {
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Commit id a ref/revision points to (None when it does not exist).
pub async fn git_rev(root: &str, repo_id: &str, rev: &str) -> Result<Option<String>, String> {
    let b = bare(root, repo_id)?;
    let spec = format!("{rev}^{{commit}}");
    let out = git_io(&b, &["rev-parse", "--verify", "--quiet", &spec], None, &[]).await?;
    Ok(if out.status.success() { Some(String::from_utf8_lossy(&out.stdout).trim().to_string()) } else { None })
}

/// Point refs/heads/<branch> at `new` (optionally only if it still equals `old`).
pub async fn git_set_branch(root: &str, repo_id: &str, branch: &str, new: &str, old: Option<&str>) -> Result<(), String> {
    let b = bare(root, repo_id)?;
    let r = format!("refs/heads/{branch}");
    let mut args = vec!["update-ref", r.as_str(), new];
    if let Some(o) = old {
        args.push(o);
    }
    ok_stdout(git_io(&b, &args, None, &[]).await?, "update-ref").map(|_| ())
}

/// Files (path, size) at any revision.
pub async fn git_tree_files_at(root: &str, repo_id: &str, rev: &str) -> Result<Vec<(String, u64)>, String> {
    let b = bare(root, repo_id)?;
    let out = git_io(&b, &["ls-tree", "-r", "-l", "-z", rev], None, &[]).await?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    for entry in out.stdout.split(|c| *c == 0) {
        let line = String::from_utf8_lossy(entry);
        let Some((meta, path)) = line.split_once('\t') else { continue };
        let parts: Vec<&str> = meta.split_whitespace().collect();
        if parts.get(1) != Some(&"blob") {
            continue;
        }
        files.push((path.to_string(), parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0)));
    }
    Ok(files)
}

/// Text of one file at a revision.
pub async fn git_read_file_at(root: &str, repo_id: &str, rev: &str, path: &str) -> Result<Option<String>, String> {
    let b = bare(root, repo_id)?;
    let spec = format!("{rev}:{path}");
    let out = git_io(&b, &["show", &spec], None, &[]).await?;
    Ok(if out.status.success() { String::from_utf8(out.stdout).ok() } else { None })
}

/// Create a commit on top of `parent` that writes `files` (path, content), without a worktree.
/// Returns the new commit id (the branch is NOT moved; use git_set_branch).
pub async fn git_commit_files(root: &str, repo_id: &str, parent: &str, files: &[(String, String)], message: &str) -> Result<String, String> {
    let b = bare(root, repo_id)?;
    let index = std::env::temp_dir().join(format!("slaver-idx-{}", crate::util::new_id()));
    let idx = index.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", idx.as_str())];
    let result = async {
        ok_stdout(git_io(&b, &["read-tree", parent], None, &env).await?, "read-tree")?;
        for (path, content) in files {
            let sha = ok_stdout(git_io(&b, &["hash-object", "-w", "--stdin"], Some(content.as_bytes()), &[]).await?, "hash-object")?;
            let info = format!("100644,{sha},{path}");
            ok_stdout(git_io(&b, &["update-index", "--add", "--cacheinfo", &info], None, &env).await?, "update-index")?;
        }
        let tree = ok_stdout(git_io(&b, &["write-tree"], None, &env).await?, "write-tree")?;
        ok_stdout(git_io(&b, &["commit-tree", &tree, "-p", parent, "-F", "-"], Some(message.as_bytes()), &[]).await?, "commit-tree")
    }
    .await;
    let _ = tokio::fs::remove_file(&index).await;
    result
}

/// gzip'd tar of a revision (what gets shipped to a staging sandbox).
pub async fn git_archive_targz(root: &str, repo_id: &str, rev: &str) -> Result<Vec<u8>, String> {
    let b = bare(root, repo_id)?;
    let out = git_io(&b, &["archive", "--format=tar.gz", rev], None, &[]).await?;
    if !out.status.success() {
        return Err(format!("git archive failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

/// Bring `from` into `into` (branch names). Fast-forward when possible, else a real merge
/// commit via merge-tree. Returns the new tip of `into`, or Err on conflicts.
pub async fn git_merge_branch(root: &str, repo_id: &str, into: &str, from: &str) -> Result<String, String> {
    let b = bare(root, repo_id)?;
    let into_sha = git_rev(root, repo_id, into).await?.ok_or("target branch missing")?;
    let from_sha = git_rev(root, repo_id, from).await?.ok_or("source branch missing")?;
    if into_sha == from_sha {
        return Ok(into_sha);
    }
    let ff = git_io(&b, &["merge-base", "--is-ancestor", &into_sha, &from_sha], None, &[]).await?;
    let new = if ff.status.success() {
        from_sha.clone()
    } else {
        let mt = git_io(&b, &["merge-tree", "--write-tree", &into_sha, &from_sha], None, &[]).await?;
        if !mt.status.success() {
            return Err("The changes conflict with newer changes on production. Undo them or ask for help.".into());
        }
        let tree = String::from_utf8_lossy(&mt.stdout).lines().next().unwrap_or("").trim().to_string();
        let msg = format!("Merge {from} into {into}");
        ok_stdout(git_io(&b, &["commit-tree", &tree, "-p", &into_sha, "-p", &from_sha, "-F", "-"], Some(msg.as_bytes()), &[]).await?, "commit-tree")?
    };
    git_set_branch(root, repo_id, into, &new, Some(&into_sha)).await?;
    Ok(new)
}
