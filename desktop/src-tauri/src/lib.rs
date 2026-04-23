use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Jivetalking availability ─────────────────────────────────────────────────

/// How jivetalking can be executed on this platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JivetalkingMethod {
    /// Native binary (Linux / macOS).
    Native,
    /// Via Windows Subsystem for Linux.
    Wsl,
    /// Not available — WSL is missing on Windows.
    Unavailable,
}

/// Probe the current platform for jivetalking support.
fn jivetalking_method() -> JivetalkingMethod {
    if cfg!(not(target_os = "windows")) {
        return JivetalkingMethod::Native;
    }
    if is_wsl_available() {
        JivetalkingMethod::Wsl
    } else {
        JivetalkingMethod::Unavailable
    }
}

/// Returns `true` when a working WSL installation (with at least one
/// distribution) is detected.  Always returns `false` on non-Windows targets.
fn is_wsl_available() -> bool {
    if cfg!(not(target_os = "windows")) {
        return false;
    }
    std::process::Command::new("wsl")
        .arg("--status")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Convert a Windows path to its WSL mount equivalent.
///
/// `C:\Users\foo\audio.flac` → `/mnt/c/Users/foo/audio.flac`
#[allow(dead_code)]
fn windows_path_to_wsl(path: &str) -> String {
    let path = path.trim();
    // Drive-letter pattern: C:\… or C:/…
    if path.len() >= 2
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
    {
        let drive = (path.as_bytes()[0] as char).to_ascii_lowercase();
        let rest = &path[2..];
        format!("/mnt/{}{}", drive, rest.replace('\\', "/"))
    } else {
        path.replace('\\', "/")
    }
}

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SermonPublishRequest {
    title: String,
    speaker: String,
    date: String,
    series: String,
    scriptures: Vec<String>,
    summary: String,
    input_video_path: String,
    hugo_content_dir: String,
    audio_output_dir: String,
    image_output_dir: String,
    slug: Option<String>,
    leading_silence_seconds: f64,
    youtube_upload_enabled: bool,
    github_owner: String,
    github_repo: String,
    github_branch: String,
    /// When true the generated markdown will have `draft: true`.
    draft: bool,
    /// If non-empty, this is an edit of an existing sermon that already has
    /// audio; the caller can choose to skip audio re-processing.
    existing_audio: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishPlan {
    slug: String,
    markdown_path: String,
    website_audio_path: String,
    thumbnail_path: String,
    cleaned_video_path: String,
    markdown: String,
    steps: Vec<PublishStep>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishStep {
    id: String,
    description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishPlanError {
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeriesInfo {
    name: String,
    sermon_count: u32,
    latest_date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeakerInfo {
    name: String,
    sermon_count: u32,
    latest_date: String,
}

/// Full details for a single sermon, populated from Hugo front-matter.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SermonEntry {
    slug: String,
    title: String,
    speaker: String,
    date: String,
    series: String,
    scriptures: Vec<String>,
    summary: String,
    audio: String,
    image: String,
    youtube_id: String,
    draft: bool,
    markdown_path: String,
}

/// Version-check result returned to the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: String,
    release_notes: String,
}

/// Describes how (or whether) jivetalking can be executed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JivetalkingStatus {
    available: bool,
    /// `"native"`, `"wsl"`, or `"unavailable"`.
    method: String,
    message: String,
}

/// Entry returned by the GitHub Contents API directory listing.
#[derive(Debug, Deserialize)]
struct GitHubContentEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

/// Body for the GitHub Contents API file-create/update endpoint.
#[derive(Debug, Serialize)]
struct GitHubCreateFileBody {
    message: String,
    /// Base64-encoded file content.
    content: String,
    branch: String,
}

/// Minimal shape of a GitHub Releases API response that we need.
#[derive(Debug, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    html_url: String,
    body: Option<String>,
}

/// Number of most-recent sermon directories to scan when building the series/speaker list.
const MAX_RECENT_SERMONS: usize = 30;

/// Maximum number of sermon entries returned by `list_sermons`.
const MAX_SERMONS_LIST: usize = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
    }

    slug.trim_matches('-').to_string()
}

fn build_markdown(
    request: &SermonPublishRequest,
    slug: &str,
    website_audio_path: &str,
    thumbnail_path: &str,
) -> String {
    let scriptures_yaml = if request.scriptures.len() <= 1 {
        let value = request.scriptures.first().map(|s| s.trim()).unwrap_or("");
        format!("scripture: \"{}\"", value)
    } else {
        let items: Vec<String> = request
            .scriptures
            .iter()
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("  - \"{}\"", s.trim()))
            .collect();
        format!("scripture:\n{}", items.join("\n"))
    };

    format!(
        "---\n\
         title: \"{}\"\n\
         date: \"{}\"\n\
         speaker: \"{}\"\n\
         series: \"{}\"\n\
         {}\n\
         audio: \"{}\"\n\
         image: \"{}\"\n\
         youtubeID: \"\"\n\
         draft: {}\n\
         slug: \"{}\"\n\
         ---\n\n\
         {}\n",
        request.title.trim(),
        request.date.trim(),
        request.speaker.trim(),
        request.series.trim(),
        scriptures_yaml,
        website_audio_path,
        thumbnail_path,
        request.draft,
        slug,
        request.summary.trim()
    )
}

/// Extract a simple `key: "value"` field from Hugo/YAML front matter.
fn extract_front_matter_field(content: &str, field: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }
    let prefix = format!("{}:", field);
    for line in content.lines().skip(1) {
        if line.trim() == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix(&prefix) {
            let value = rest.trim().trim_matches('"').to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// Extract a potentially-multi-valued YAML field (e.g. `scripture`) from Hugo
/// front-matter.  Handles both the single-value form (`scripture: "…"`) and
/// the list form (`scripture:\n  - "…"`).
fn extract_multi_field(content: &str, field: &str) -> Vec<String> {
    if !content.starts_with("---") {
        return Vec::new();
    }
    let prefix = format!("{}:", field);
    let mut result = Vec::new();
    let mut collecting_list = false;

    for line in content.lines().skip(1) {
        if line.trim() == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix(&prefix) {
            collecting_list = false;
            let value = rest.trim().trim_matches('"').to_string();
            if value.is_empty() {
                collecting_list = true;
            } else {
                result.push(value);
            }
            continue;
        }
        if collecting_list {
            let trimmed = line.trim();
            if let Some(item) = trimmed.strip_prefix("- ") {
                let clean = item.trim().trim_matches('"').to_string();
                if !clean.is_empty() {
                    result.push(clean);
                }
            } else if !trimmed.is_empty() {
                collecting_list = false;
            }
        }
    }

    result
}

/// Return the text body that follows the Hugo front-matter delimiter.
fn extract_body_from_markdown(content: &str) -> String {
    if !content.starts_with("---") {
        return content.trim().to_string();
    }
    let mut found_first = false;
    let mut found_second = false;
    let mut body_lines: Vec<&str> = Vec::new();

    for line in content.lines() {
        if !found_first {
            if line.trim() == "---" {
                found_first = true;
            }
            continue;
        }
        if !found_second {
            if line.trim() == "---" {
                found_second = true;
            }
            continue;
        }
        body_lines.push(line);
    }

    body_lines.join("\n").trim().to_string()
}

/// Parse a boolean front-matter field (returns `false` when absent).
fn parse_bool_field(content: &str, field: &str) -> bool {
    extract_front_matter_field(content, field)
        .map(|v| v.to_lowercase() == "true")
        .unwrap_or(false)
}

/// Simple semver comparison: returns `true` when `candidate` is newer than
/// `current`.  Leading `v` prefixes are stripped automatically.
fn is_newer_version(current: &str, candidate: &str) -> bool {
    let strip = |v: &str| v.trim_start_matches('v').to_string();
    let parse = |v: &str| -> (u64, u64, u64) {
        let mut parts = v.split('.').filter_map(|s| s.parse::<u64>().ok());
        (
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        )
    };
    parse(&strip(candidate)) > parse(&strip(current))
}

/// Build a GitHub Contents API URL for reading/writing a file.
fn github_contents_url(owner: &str, repo: &str, path: &str, branch: &str) -> String {
    format!(
        "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
        owner, repo, path, branch
    )
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Report how jivetalking can be executed on this system.
#[tauri::command]
fn check_jivetalking_status() -> JivetalkingStatus {
    match jivetalking_method() {
        JivetalkingMethod::Native => JivetalkingStatus {
            available: true,
            method: "native".to_string(),
            message: "Jivetalking is available natively".to_string(),
        },
        JivetalkingMethod::Wsl => JivetalkingStatus {
            available: true,
            method: "wsl".to_string(),
            message: "Jivetalking will run via Windows Subsystem for Linux".to_string(),
        },
        JivetalkingMethod::Unavailable => JivetalkingStatus {
            available: false,
            method: "unavailable".to_string(),
            message: "Jivetalking is not available. Install WSL by running \
                      'wsl --install' in an admin PowerShell to enable audio normalisation."
                .to_string(),
        },
    }
}

#[tauri::command]
fn build_publish_plan(request: SermonPublishRequest) -> Result<PublishPlan, PublishPlanError> {
    if request.title.trim().is_empty() {
        return Err(PublishPlanError {
            message: "Title is required".to_string(),
        });
    }

    // If editing an existing sermon with audio, allow skipping a new video path.
    let has_existing_audio = !request.existing_audio.trim().is_empty();
    if request.input_video_path.trim().is_empty() && !has_existing_audio {
        return Err(PublishPlanError {
            message: "Input video path is required".to_string(),
        });
    }

    if request.leading_silence_seconds < 0.0 || request.leading_silence_seconds > 120.0 {
        return Err(PublishPlanError {
            message: "Leading silence must be between 0 and 120 seconds".to_string(),
        });
    }

    if request.github_owner.trim().is_empty() || request.github_repo.trim().is_empty() {
        return Err(PublishPlanError {
            message: "GitHub repository owner and name are required".to_string(),
        });
    }

    let slug = request
        .slug
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(slugify)
        .unwrap_or_else(|| slugify(&format!("{} {}", request.date, request.title)));

    if slug.is_empty() {
        return Err(PublishPlanError {
            message: "Unable to generate slug from title/date".to_string(),
        });
    }

    let markdown_path = format!(
        "{}/{}/index.md",
        request.hugo_content_dir.trim_end_matches('/'),
        slug
    );
    let website_audio_path = format!(
        "{}/{}.mp3",
        request.audio_output_dir.trim_end_matches('/'),
        slug
    );
    let thumbnail_path = format!(
        "{}/{}.jpg",
        request.image_output_dir.trim_end_matches('/'),
        slug
    );
    let cleaned_video_path = format!("working/{}-youtube.mp4", slug);

    let markdown = build_markdown(&request, &slug, &website_audio_path, &thumbnail_path);

    let mut steps: Vec<PublishStep> = Vec::new();

    if !has_existing_audio || !request.input_video_path.trim().is_empty() {
        // New video provided — process audio.
        steps.push(PublishStep {
            id: "extract-audio".to_string(),
            description: "Extract raw audio from source video".to_string(),
        });

        match jivetalking_method() {
            JivetalkingMethod::Native => {
                steps.push(PublishStep {
                    id: "run-jivetalking".to_string(),
                    description: "Run Jivetalking on full extracted audio".to_string(),
                });
            }
            JivetalkingMethod::Wsl => {
                steps.push(PublishStep {
                    id: "run-jivetalking-wsl".to_string(),
                    description: "Run Jivetalking on full extracted audio (via WSL)".to_string(),
                });
            }
            JivetalkingMethod::Unavailable => {
                steps.push(PublishStep {
                    id: "skip-jivetalking".to_string(),
                    description: "Skip Jivetalking audio normalisation (WSL not available; \
                                  run 'wsl --install' in an admin PowerShell to enable)"
                        .to_string(),
                });
            }
        }

        steps.extend([
            PublishStep {
                id: "detect-leading-silence".to_string(),
                description: format!(
                    "Trim leading silence ({:.1}s) from processed audio",
                    request.leading_silence_seconds
                ),
            },
            PublishStep {
                id: "create-website-audio".to_string(),
                description: "Create cleaned website audio file".to_string(),
            },
            PublishStep {
                id: "create-thumbnail".to_string(),
                description: "Generate thumbnail image".to_string(),
            },
            PublishStep {
                id: "create-youtube-video".to_string(),
                description: "Create cleaned YouTube video with replaced audio".to_string(),
            },
        ]);
    } else {
        steps.push(PublishStep {
            id: "keep-existing-audio".to_string(),
            description: format!(
                "Keep existing audio: {}",
                request.existing_audio.trim()
            ),
        });
    }

    steps.extend([
        PublishStep {
            id: "generate-markdown".to_string(),
            description: format!(
                "Generate sermon markdown (draft: {})",
                request.draft
            ),
        },
        PublishStep {
            id: "github-write".to_string(),
            description: format!(
                "Write files to {}/{} ({}) via GitHub API",
                request.github_owner.trim(),
                request.github_repo.trim(),
                request.github_branch.trim()
            ),
        },
    ]);

    if request.youtube_upload_enabled && !has_existing_audio {
        steps.push(PublishStep {
            id: "youtube-upload".to_string(),
            description: "Upload cleaned video to YouTube and patch markdown youtubeID"
                .to_string(),
        });
    }

    Ok(PublishPlan {
        slug,
        markdown_path,
        website_audio_path,
        thumbnail_path,
        cleaned_video_path,
        markdown,
        steps,
    })
}

/// Run ffmpeg silence-detection on a video and return the end-time (seconds) of
/// the first detected silent region (i.e. the leading silence duration).
#[tauri::command]
fn detect_leading_silence(video_path: String) -> Result<f64, String> {
    let output = std::process::Command::new("ffmpeg")
        .args([
            "-i",
            &video_path,
            "-af",
            "silencedetect=noise=-30dB:d=0.5",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}. Is ffmpeg installed?", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);

    for line in stderr.lines() {
        if let Some(pos) = line.find("silence_end:") {
            let after = &line[pos + "silence_end:".len()..];
            if let Some(seconds_str) = after.split('|').next() {
                if let Ok(seconds) = seconds_str.trim().parse::<f64>() {
                    // Round to one decimal place.
                    let precision = 10.0_f64;
                    return Ok((seconds * precision).round() / precision);
                }
            }
        }
    }

    Err("No leading silence detected in the video".to_string())
}

/// Fetch the list of sermon series from the Hugo site's GitHub repository by
/// reading the content directory and parsing front-matter from recent entries.
#[tauri::command]
async fn list_series(
    github_owner: String,
    github_repo: String,
    github_branch: String,
    github_token: String,
    content_dir: String,
) -> Result<Vec<SeriesInfo>, String> {
    let client = reqwest::Client::new();
    let dir_path = content_dir.trim_matches('/');

    let dir_url = github_contents_url(&github_owner, &github_repo, dir_path, &github_branch);

    let dir_response = client
        .get(&dir_url)
        .header("Authorization", format!("Bearer {}", github_token))
        .header("User-Agent", "SermonPublisher")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to GitHub: {}", e))?;

    if dir_response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "CONTENT_DIR_NOT_FOUND: The directory '{}' does not exist in the repository.",
            dir_path
        ));
    }

    if !dir_response.status().is_success() {
        let status = dir_response.status();
        let body = dir_response.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned {} — {}", status, body));
    }

    let entries: Vec<GitHubContentEntry> = dir_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse directory listing: {}", e))?;

    let mut dirs: Vec<&GitHubContentEntry> =
        entries.iter().filter(|e| e.entry_type == "dir").collect();
    dirs.sort_by(|a, b| a.name.cmp(&b.name));

    let recent: Vec<&&GitHubContentEntry> = dirs.iter().rev().take(MAX_RECENT_SERMONS).collect();
    let mut series_map: HashMap<String, SeriesInfo> = HashMap::new();

    for dir in recent {
        let raw_url = format!(
            "https://raw.githubusercontent.com/{}/{}/{}/{}/{}/index.md",
            github_owner, github_repo, github_branch, dir_path, dir.name
        );

        let file_resp = client
            .get(&raw_url)
            .header("Authorization", format!("Bearer {}", github_token))
            .header("User-Agent", "SermonPublisher")
            .send()
            .await;

        if let Ok(resp) = file_resp {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Some(series_name) = extract_front_matter_field(&text, "series") {
                        let date =
                            extract_front_matter_field(&text, "date").unwrap_or_default();
                        let entry =
                            series_map.entry(series_name.clone()).or_insert(SeriesInfo {
                                name: series_name,
                                sermon_count: 0,
                                latest_date: String::new(),
                            });
                        entry.sermon_count += 1;
                        if date > entry.latest_date {
                            entry.latest_date = date;
                        }
                    }
                }
            }
        }
    }

    let mut series: Vec<SeriesInfo> = series_map.into_values().collect();
    series.sort_by(|a, b| b.latest_date.cmp(&a.latest_date));

    Ok(series)
}

/// Fetch the list of speakers/preachers from the Hugo site's GitHub repository
/// by reading the content directory and parsing front-matter from recent entries.
#[tauri::command]
async fn list_speakers(
    github_owner: String,
    github_repo: String,
    github_branch: String,
    github_token: String,
    content_dir: String,
) -> Result<Vec<SpeakerInfo>, String> {
    let client = reqwest::Client::new();
    let dir_path = content_dir.trim_matches('/');

    let dir_url = github_contents_url(&github_owner, &github_repo, dir_path, &github_branch);

    let dir_response = client
        .get(&dir_url)
        .header("Authorization", format!("Bearer {}", github_token))
        .header("User-Agent", "SermonPublisher")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to GitHub: {}", e))?;

    if dir_response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "CONTENT_DIR_NOT_FOUND: The directory '{}' does not exist in the repository.",
            dir_path
        ));
    }

    if !dir_response.status().is_success() {
        let status = dir_response.status();
        let body = dir_response.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned {} — {}", status, body));
    }

    let entries: Vec<GitHubContentEntry> = dir_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse directory listing: {}", e))?;

    let mut dirs: Vec<&GitHubContentEntry> =
        entries.iter().filter(|e| e.entry_type == "dir").collect();
    dirs.sort_by(|a, b| a.name.cmp(&b.name));

    let recent: Vec<&&GitHubContentEntry> = dirs.iter().rev().take(MAX_RECENT_SERMONS).collect();
    let mut speaker_map: HashMap<String, SpeakerInfo> = HashMap::new();

    for dir in recent {
        let raw_url = format!(
            "https://raw.githubusercontent.com/{}/{}/{}/{}/{}/index.md",
            github_owner, github_repo, github_branch, dir_path, dir.name
        );

        let file_resp = client
            .get(&raw_url)
            .header("Authorization", format!("Bearer {}", github_token))
            .header("User-Agent", "SermonPublisher")
            .send()
            .await;

        if let Ok(resp) = file_resp {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Some(speaker_name) = extract_front_matter_field(&text, "speaker") {
                        let date =
                            extract_front_matter_field(&text, "date").unwrap_or_default();
                        let entry =
                            speaker_map.entry(speaker_name.clone()).or_insert(SpeakerInfo {
                                name: speaker_name,
                                sermon_count: 0,
                                latest_date: String::new(),
                            });
                        entry.sermon_count += 1;
                        if date > entry.latest_date {
                            entry.latest_date = date;
                        }
                    }
                }
            }
        }
    }

    let mut speakers: Vec<SpeakerInfo> = speaker_map.into_values().collect();
    speakers.sort_by(|a, b| b.sermon_count.cmp(&a.sermon_count).then(a.name.cmp(&b.name)));

    Ok(speakers)
}

/// Fetch the full list of sermons from the Hugo site's GitHub repository.
#[tauri::command]
async fn list_sermons(
    github_owner: String,
    github_repo: String,
    github_branch: String,
    github_token: String,
    content_dir: String,
) -> Result<Vec<SermonEntry>, String> {
    let client = reqwest::Client::new();
    let dir_path = content_dir.trim_matches('/');

    let dir_url = github_contents_url(&github_owner, &github_repo, dir_path, &github_branch);

    let dir_response = client
        .get(&dir_url)
        .header("Authorization", format!("Bearer {}", github_token))
        .header("User-Agent", "SermonPublisher")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to GitHub: {}", e))?;

    if dir_response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "CONTENT_DIR_NOT_FOUND: The directory '{}' does not exist in the repository.",
            dir_path
        ));
    }

    if !dir_response.status().is_success() {
        let status = dir_response.status();
        let body = dir_response.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned {} — {}", status, body));
    }

    let entries: Vec<GitHubContentEntry> = dir_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse directory listing: {}", e))?;

    let mut dirs: Vec<&GitHubContentEntry> =
        entries.iter().filter(|e| e.entry_type == "dir").collect();
    // Sort newest-first (date-prefixed slugs give chronological order).
    dirs.sort_by(|a, b| b.name.cmp(&a.name));
    dirs.truncate(MAX_SERMONS_LIST);

    let mut sermons: Vec<SermonEntry> = Vec::new();

    for dir in dirs {
        let markdown_path = format!("{}/{}/index.md", dir_path, dir.name);
        let raw_url = format!(
            "https://raw.githubusercontent.com/{}/{}/{}/{}/{}/index.md",
            github_owner, github_repo, github_branch, dir_path, dir.name
        );

        let file_resp = client
            .get(&raw_url)
            .header("Authorization", format!("Bearer {}", github_token))
            .header("User-Agent", "SermonPublisher")
            .send()
            .await;

        if let Ok(resp) = file_resp {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    let slug = extract_front_matter_field(&text, "slug")
                        .unwrap_or_else(|| dir.name.clone());
                    let title = extract_front_matter_field(&text, "title")
                        .unwrap_or_default();
                    let speaker = extract_front_matter_field(&text, "speaker")
                        .unwrap_or_default();
                    let date = extract_front_matter_field(&text, "date")
                        .unwrap_or_default();
                    let series = extract_front_matter_field(&text, "series")
                        .unwrap_or_default();
                    let scriptures = extract_multi_field(&text, "scripture");
                    let audio = extract_front_matter_field(&text, "audio")
                        .unwrap_or_default();
                    let image = extract_front_matter_field(&text, "image")
                        .unwrap_or_default();
                    let youtube_id = extract_front_matter_field(&text, "youtubeID")
                        .unwrap_or_default();
                    let draft = parse_bool_field(&text, "draft");
                    let summary = extract_body_from_markdown(&text);

                    sermons.push(SermonEntry {
                        slug,
                        title,
                        speaker,
                        date,
                        series,
                        scriptures,
                        summary,
                        audio,
                        image,
                        youtube_id,
                        draft,
                        markdown_path,
                    });
                }
            }
        }
    }

    Ok(sermons)
}

/// Create the sermon content directory in the GitHub repository by committing a
/// README.md placeholder file.  This is offered to users when the directory does
/// not yet exist (e.g. new site).
#[tauri::command]
async fn create_content_directory(
    github_owner: String,
    github_repo: String,
    github_branch: String,
    github_token: String,
    content_dir: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let dir_path = content_dir.trim_matches('/');
    let file_path = format!("{}/README.md", dir_path);

    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        github_owner, github_repo, file_path
    );

    // "# Sermons\n" base64-encoded.
    let content_b64 = "IyBTZXJtb25zCg==";

    let body = GitHubCreateFileBody {
        message: "Initialize sermon content directory".to_string(),
        content: content_b64.to_string(),
        branch: github_branch.clone(),
    };

    let resp = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", github_token))
        .header("User-Agent", "SermonPublisher")
        .header("Accept", "application/vnd.github.v3+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to GitHub: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub API returned {} when creating directory: {}",
            status, text
        ));
    }

    Ok(())
}

/// Write the given JSON string to a file on the local filesystem.
/// The `path` is obtained from the frontend via the Tauri dialog plugin.
#[tauri::command]
fn save_settings_to_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Read a JSON string from a file on the local filesystem.
/// The `path` is obtained from the frontend via the Tauri dialog plugin.
#[tauri::command]
fn load_settings_from_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

/// Check whether a newer version of Sermon Publisher is available on GitHub.
#[tauri::command]
async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let client = reqwest::Client::new();

    let resp = client
        .get("https://api.github.com/repos/halcycon/SermonPublisher/releases/latest")
        .header("User-Agent", "SermonPublisher")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub returned {} when checking for updates",
            resp.status()
        ));
    }

    let release: GitHubReleaseResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let update_available = is_newer_version(&current_version, &latest_version);

    Ok(UpdateInfo {
        update_available,
        current_version,
        latest_version,
        release_url: release.html_url,
        release_notes: release.body.unwrap_or_default(),
    })
}

// ── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            build_publish_plan,
            check_jivetalking_status,
            detect_leading_silence,
            list_series,
            list_speakers,
            list_sermons,
            create_content_directory,
            save_settings_to_file,
            load_settings_from_file,
            check_for_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_normalizes_title() {
        assert_eq!(
            slugify("Palm Sunday: Christ's Entry!"),
            "palm-sunday-christ-s-entry"
        );
    }

    #[test]
    fn is_newer_version_works() {
        assert!(is_newer_version("0.1.0", "0.2.0"));
        assert!(is_newer_version("0.1.0", "v0.2.0"));
        assert!(!is_newer_version("0.2.0", "0.1.0"));
        assert!(!is_newer_version("0.1.0", "0.1.0"));
    }

    #[test]
    fn extract_multi_field_single() {
        let md = "---\ntitle: \"Test\"\nscripture: \"John 10:1-18\"\n---\n\nBody.";
        assert_eq!(
            extract_multi_field(md, "scripture"),
            vec!["John 10:1-18"]
        );
    }

    #[test]
    fn extract_multi_field_list() {
        let md = "---\ntitle: \"Test\"\nscripture:\n  - \"John 10:1-18\"\n  - \"Psalm 23\"\n---\n";
        let result = extract_multi_field(md, "scripture");
        assert_eq!(result, vec!["John 10:1-18", "Psalm 23"]);
    }

    #[test]
    fn build_publish_plan_contains_required_steps() {
        let request = SermonPublishRequest {
            title: "The Good Shepherd".to_string(),
            speaker: "Jane Doe".to_string(),
            date: "2026-04-19".to_string(),
            series: "John".to_string(),
            scriptures: vec!["John 10".to_string()],
            summary: "Jesus is the good shepherd.".to_string(),
            input_video_path: "C:/recordings/sermon.mp4".to_string(),
            hugo_content_dir: "content/sermons".to_string(),
            audio_output_dir: "static/audio".to_string(),
            image_output_dir: "static/images/sermons".to_string(),
            slug: None,
            leading_silence_seconds: 12.0,
            youtube_upload_enabled: true,
            github_owner: "myorg".to_string(),
            github_repo: "mysite".to_string(),
            github_branch: "main".to_string(),
            draft: false,
            existing_audio: String::new(),
        };

        let plan = build_publish_plan(request).expect("plan should build");

        assert!(plan.steps.iter().any(|s| s.id == "run-jivetalking"
            || s.id == "run-jivetalking-wsl"
            || s.id == "skip-jivetalking"));
        assert!(plan.steps.iter().any(|s| s.id == "github-write"));
        assert!(plan.steps.iter().any(|s| s.id == "youtube-upload"));
        assert!(plan.markdown.contains("youtubeID"));
        assert!(plan.markdown.contains("draft: false"));
    }

    #[test]
    fn build_publish_plan_draft_flag() {
        let request = SermonPublishRequest {
            title: "Draft Sermon".to_string(),
            speaker: "Jane Doe".to_string(),
            date: "2026-04-19".to_string(),
            series: "John".to_string(),
            scriptures: vec![],
            summary: String::new(),
            input_video_path: "C:/recordings/sermon.mp4".to_string(),
            hugo_content_dir: "content/sermons".to_string(),
            audio_output_dir: "static/audio".to_string(),
            image_output_dir: "static/images/sermons".to_string(),
            slug: None,
            leading_silence_seconds: 0.0,
            youtube_upload_enabled: false,
            github_owner: "myorg".to_string(),
            github_repo: "mysite".to_string(),
            github_branch: "main".to_string(),
            draft: true,
            existing_audio: String::new(),
        };

        let plan = build_publish_plan(request).expect("plan should build");
        assert!(plan.markdown.contains("draft: true"));
    }

    #[test]
    fn build_publish_plan_edit_keeps_existing_audio() {
        let request = SermonPublishRequest {
            title: "Edited Sermon".to_string(),
            speaker: "Jane Doe".to_string(),
            date: "2026-04-19".to_string(),
            series: "John".to_string(),
            scriptures: vec![],
            summary: String::new(),
            input_video_path: String::new(), // no new video
            hugo_content_dir: "content/sermons".to_string(),
            audio_output_dir: "static/audio".to_string(),
            image_output_dir: "static/images/sermons".to_string(),
            slug: None,
            leading_silence_seconds: 0.0,
            youtube_upload_enabled: false,
            github_owner: "myorg".to_string(),
            github_repo: "mysite".to_string(),
            github_branch: "main".to_string(),
            draft: false,
            existing_audio: "static/audio/sermons/old-sermon.mp3".to_string(),
        };

        let plan = build_publish_plan(request).expect("plan should build");
        assert!(plan
            .steps
            .iter()
            .any(|s| s.id == "keep-existing-audio"));
        assert!(!plan.steps.iter().any(|s| s.id == "extract-audio"));
    }

    #[test]
    fn build_publish_plan_multiple_scriptures() {
        let request = SermonPublishRequest {
            title: "The Good Shepherd".to_string(),
            speaker: "Jane Doe".to_string(),
            date: "2026-04-19".to_string(),
            series: "John".to_string(),
            scriptures: vec!["John 10:1-18".to_string(), "Psalm 23".to_string()],
            summary: "".to_string(),
            input_video_path: "C:/recordings/sermon.mp4".to_string(),
            hugo_content_dir: "content/sermons".to_string(),
            audio_output_dir: "static/audio".to_string(),
            image_output_dir: "static/images/sermons".to_string(),
            slug: None,
            leading_silence_seconds: 12.0,
            youtube_upload_enabled: false,
            github_owner: "myorg".to_string(),
            github_repo: "mysite".to_string(),
            github_branch: "main".to_string(),
            draft: false,
            existing_audio: String::new(),
        };

        let plan = build_publish_plan(request).expect("plan should build");
        assert!(plan.markdown.contains("John 10:1-18"));
        assert!(plan.markdown.contains("Psalm 23"));
    }
}
