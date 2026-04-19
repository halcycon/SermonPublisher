use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

/// Entry returned by the GitHub Contents API directory listing.
#[derive(Debug, Deserialize)]
struct GitHubContentEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

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
         draft: false\n\
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

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn build_publish_plan(request: SermonPublishRequest) -> Result<PublishPlan, PublishPlanError> {
    if request.title.trim().is_empty() {
        return Err(PublishPlanError {
            message: "Title is required".to_string(),
        });
    }

    if request.input_video_path.trim().is_empty() {
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

    let mut steps = vec![
        PublishStep {
            id: "extract-audio".to_string(),
            description: "Extract raw audio from source video".to_string(),
        },
        PublishStep {
            id: "run-jivetalking".to_string(),
            description: "Run Jivetalking on full extracted audio".to_string(),
        },
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
        PublishStep {
            id: "generate-markdown".to_string(),
            description: "Generate sermon markdown file".to_string(),
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
    ];

    if request.youtube_upload_enabled {
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
                    return Ok((seconds * 10.0).round() / 10.0);
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

    // 1. List the content directory via the GitHub Contents API.
    let dir_url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
        github_owner, github_repo, dir_path, github_branch
    );

    let dir_response = client
        .get(&dir_url)
        .header("Authorization", format!("Bearer {}", github_token))
        .header("User-Agent", "SermonPublisher")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to GitHub: {}", e))?;

    if !dir_response.status().is_success() {
        let status = dir_response.status();
        let body = dir_response.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned {} — {}", status, body));
    }

    let entries: Vec<GitHubContentEntry> = dir_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse directory listing: {}", e))?;

    // Keep only directories, sorted alphabetically (date-prefixed names give
    // chronological order).
    let mut dirs: Vec<&GitHubContentEntry> =
        entries.iter().filter(|e| e.entry_type == "dir").collect();
    dirs.sort_by(|a, b| a.name.cmp(&b.name));

    // 2. For the most-recent entries, fetch raw index.md and extract series.
    let recent: Vec<&&GitHubContentEntry> = dirs.iter().rev().take(30).collect();
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

// ── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            build_publish_plan,
            detect_leading_silence,
            list_series
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
        };

        let plan = build_publish_plan(request).expect("plan should build");

        assert!(plan.steps.iter().any(|s| s.id == "run-jivetalking"));
        assert!(plan.steps.iter().any(|s| s.id == "github-write"));
        assert!(plan.steps.iter().any(|s| s.id == "youtube-upload"));
        assert!(plan.markdown.contains("youtubeID"));
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
        };

        let plan = build_publish_plan(request).expect("plan should build");
        assert!(plan.markdown.contains("John 10:1-18"));
        assert!(plan.markdown.contains("Psalm 23"));
    }

    #[test]
    fn build_publish_plan_requires_github_config() {
        let request = SermonPublishRequest {
            title: "Test".to_string(),
            speaker: "".to_string(),
            date: "2026-01-01".to_string(),
            series: "".to_string(),
            scriptures: vec![],
            summary: "".to_string(),
            input_video_path: "C:/test.mp4".to_string(),
            hugo_content_dir: "content/sermons".to_string(),
            audio_output_dir: "static/audio".to_string(),
            image_output_dir: "static/images/sermons".to_string(),
            slug: None,
            leading_silence_seconds: 10.0,
            youtube_upload_enabled: false,
            github_owner: "".to_string(),
            github_repo: "".to_string(),
            github_branch: "main".to_string(),
        };

        let result = build_publish_plan(request);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("GitHub"));
    }

    #[test]
    fn extract_front_matter_series() {
        let content =
            "---\ntitle: \"Test\"\nseries: \"John\"\ndate: \"2026-04-19\"\n---\n\nBody";
        assert_eq!(
            extract_front_matter_field(content, "series"),
            Some("John".to_string())
        );
    }

    #[test]
    fn extract_front_matter_returns_none_for_missing_field() {
        let content = "---\ntitle: \"Test\"\n---\n\nBody";
        assert_eq!(extract_front_matter_field(content, "series"), None);
    }
}
