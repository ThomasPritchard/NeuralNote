use super::service::video_id_from_url;
use neuralnote_core::ai::YoutubeUrl;

#[test]
fn extracts_only_valid_video_ids_from_supported_full_urls() {
    let watch = YoutubeUrl::new("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1").unwrap();
    let short = YoutubeUrl::new("https://youtu.be/-abcdefghij").unwrap();
    let shorts = YoutubeUrl::new("https://www.youtube.com/shorts/jNQXAC9IVRw").unwrap();
    let embed = YoutubeUrl::new("https://www.youtube.com/embed/jNQXAC9IVRw").unwrap();
    let live = YoutubeUrl::new("https://www.youtube.com/live/jNQXAC9IVRw").unwrap();
    let playlist = YoutubeUrl::new("https://www.youtube.com/playlist?list=PL123").unwrap();

    assert_eq!(video_id_from_url(&watch).unwrap().as_ref(), "jNQXAC9IVRw");
    assert_eq!(video_id_from_url(&short).unwrap().as_ref(), "-abcdefghij");
    for url in [&shorts, &embed, &live] {
        assert_eq!(video_id_from_url(url).unwrap().as_ref(), "jNQXAC9IVRw");
    }
    assert!(video_id_from_url(&playlist).is_none());
}
