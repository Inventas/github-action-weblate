export const XCSTRINGS_FORMAT = "xcstrings";

export function isXcstringsComponent(component) {
  return component.file_format === XCSTRINGS_FORMAT;
}

export function catalogTranslations(component) {
  if (!isXcstringsComponent(component)) {
    return component.translations;
  }

  const seenPaths = new Set();
  return component.translations.filter((translation) => {
    if (!translation.path || seenPaths.has(translation.path)) {
      return false;
    }
    seenPaths.add(translation.path);
    return true;
  });
}
