// How a model's id reads to people. Cursor's ids carry their settings in brackets ("claude-sonnet-4-5[thinking=true,
// context=200k]"); the id is what's saved and sent, the label is what's shown. Shared by the gateway and the app.

/** `claude-sonnet-4-5[thinking=true,context=200k]` → `claude-sonnet-4-5 (thinking, context 200k)`; others as they are. */
export function modelLabel(id: string): string {
  const match = /^([^[\]]+)\[([^[\]]*)\]$/.exec(id);
  if (!match?.[1]) return id;
  const settings = (match[2] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [key = "", ...rest] = part.split("=");
      const value = rest.join("=");
      const name = key.replaceAll("_", " ").trim();
      if (value === "true") return [name];
      if (value === "false") return [];
      return [value ? `${name} ${value.replaceAll("_", " ")}` : name];
    });
  return settings.length ? `${match[1]} (${settings.join(", ")})` : match[1];
}

/** Cursor's own "Auto" entry repeats the pickers' "Default" (the provider chooses), so lists leave it out. */
export function listedModels(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== "default[]");
}
