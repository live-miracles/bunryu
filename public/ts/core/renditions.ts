// Twin of isRenditionUrl in src/utils/renditions.ts (the dashboard cannot import
// backend code). test/renditions.test.js runs both on the same URLs and asserts
// they agree, so change them together.
const RENDITION_URL_RE = /^rtmp:\/\/127\.0\.0\.1:\d+\/internal\/r\d+_[a-z0-9_]+_a[a-z0-9]+$/;

export function isRenditionUrl(url: string): boolean {
    return RENDITION_URL_RE.test(url);
}
