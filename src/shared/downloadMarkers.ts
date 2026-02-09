const LEGACY_PREFIX = 'legacy-filename::';
const V2_PREFIX = 'v2::';

export function createDownloadMarker(courseDigit: string, rid: string): string {
  return `${V2_PREFIX}${courseDigit}::${rid}`;
}

export function createLegacyFilenameMarker(fileName: string): string {
  return `${LEGACY_PREFIX}${fileName}`;
}

export function isDownloaded(
  downloaded: Set<string>,
  marker: string,
  legacyFileName?: string
): boolean {
  if (downloaded.has(marker)) {
    return true;
  }

  if (!legacyFileName) {
    return false;
  }

  return downloaded.has(legacyFileName) || downloaded.has(createLegacyFilenameMarker(legacyFileName));
}

export function migrateLegacyDownloadedItems(items: Iterable<string>): Set<string> {
  const next = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }

    if (item.startsWith(V2_PREFIX) || item.startsWith(LEGACY_PREFIX)) {
      next.add(item);
      continue;
    }

    next.add(item);
    next.add(createLegacyFilenameMarker(item));
  }

  return next;
}
