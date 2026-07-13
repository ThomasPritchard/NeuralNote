export interface YoutubeTimestampJump {
  href: string;
  label: string;
}

const YOUTUBE_TIMESTAMP_LINK =
  /(?:^|\s)\[(\d{2,6}):([0-5]\d):([0-5]\d)\]\((https:\/\/[^\s)]+)\)/;

/** Parse only neuralnote-core's exact linked-anchor form. The core derives the
 *  link from validated YouTube metadata; this second validation keeps arbitrary
 *  markdown URLs from becoming a trusted-looking timestamp affordance. */
export function parseYoutubeTimestampJump(
  text: string,
): YoutubeTimestampJump | null {
  const match = YOUTUBE_TIMESTAMP_LINK.exec(text);
  if (match === null) return null;

  const [, hours, minutes, seconds, rawUrl] = match;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const videoId = url.pathname.slice(1);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "youtu.be" ||
    !/^[A-Za-z0-9_-]{11}$/.test(videoId)
  ) {
    return null;
  }

  const totalSeconds =
    Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
  if (!Number.isSafeInteger(totalSeconds)) return null;
  return {
    href: `https://youtu.be/${videoId}?t=${totalSeconds}`,
    label: hours === "00" ? `${minutes}:${seconds}` : `${hours}:${minutes}:${seconds}`,
  };
}
