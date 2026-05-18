export function formatAccountDisplayName(alias: string): string {
  const trimmed = alias.trim();
  const atIndex = trimmed.indexOf("@");
  const name = atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  return name.replace(/[.]+$/g, "") || name || trimmed;
}

export function formatCompactAccountDisplayName(alias: string): string {
  const displayName = formatAccountDisplayName(alias);
  if (displayName.length <= 18) return displayName;
  return `${displayName.slice(0, 15)}...`;
}
