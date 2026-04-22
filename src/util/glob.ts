/**
 * Minimal glob/minimatch implementation for path matching.
 * Supports **, *, and ? patterns. No external dependency needed.
 */
export function minimatch(filePath: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(filePath);
}

function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any number of path segments
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (c === ".") {
      regexStr += "\\.";
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}
