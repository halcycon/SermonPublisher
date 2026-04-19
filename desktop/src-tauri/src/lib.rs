use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SermonPublishRequest {
    title: String,
    speaker: String,
    date: String,
    series: String,
    scripture: String,
    summary: String,
    input_video_path: String,
    hugo_content_dir: String,
    audio_output_dir: String,
    image_output_dir: String,
    slug: Option<String>,
    leading_silence_seconds: u16,
    youtube_upload_enabled: bool,
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

fn build_markdown(request: &SermonPublishRequest, slug: &str, website_audio_path: &str, thumbnail_path: &str) -> String {
    format!(
        "---\n\
         title: \"{}\"\n\
         date: \"{}\"\n\
         speaker: \"{}\"\n\
         series: \"{}\"\n\
         scripture: \"{}\"\n\
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
        request.scripture.trim(),
        website_audio_path,
        thumbnail_path,
        slug,
        request.summary.trim()
    )
}

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

    if !(1..=120).contains(&request.leading_silence_seconds) {
        return Err(PublishPlanError {
            message: "Leading silence must be between 1 and 120 seconds".to_string(),
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

    let markdown_path = format!("{}/{}/index.md", request.hugo_content_dir.trim_end_matches('/'), slug);
    let website_audio_path = format!("{}/{}.mp3", request.audio_output_dir.trim_end_matches('/'), slug);
    let thumbnail_path = format!("{}/{}.jpg", request.image_output_dir.trim_end_matches('/'), slug);
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
                "Detect end of leading silence (target {} seconds) and trim processed audio",
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
            description: "Write markdown/audio/image files to GitHub repo via API".to_string(),
        },
    ];

    if request.youtube_upload_enabled {
        steps.push(PublishStep {
            id: "youtube-upload".to_string(),
            description: "Upload cleaned video to YouTube and patch markdown youtubeID".to_string(),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![build_publish_plan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_normalizes_title() {
        assert_eq!(slugify("Palm Sunday: Christ's Entry!"), "palm-sunday-christ-s-entry");
    }

    #[test]
    fn build_publish_plan_contains_required_steps() {
        let request = SermonPublishRequest {
            title: "The Good Shepherd".to_string(),
            speaker: "Jane Doe".to_string(),
            date: "2026-04-19".to_string(),
            series: "John".to_string(),
            scripture: "John 10".to_string(),
            summary: "Jesus is the good shepherd.".to_string(),
            input_video_path: "C:/recordings/sermon.mp4".to_string(),
            hugo_content_dir: "content/sermons".to_string(),
            audio_output_dir: "static/audio".to_string(),
            image_output_dir: "static/images/sermons".to_string(),
            slug: None,
            leading_silence_seconds: 12,
            youtube_upload_enabled: true,
        };

        let plan = build_publish_plan(request).expect("plan should build");

        assert!(plan.steps.iter().any(|s| s.id == "run-jivetalking"));
        assert!(plan.steps.iter().any(|s| s.id == "github-write"));
        assert!(plan.steps.iter().any(|s| s.id == "youtube-upload"));
        assert!(plan.markdown.contains("youtubeID"));
    }
}
