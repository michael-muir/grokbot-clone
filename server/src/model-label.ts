// How a model's id reads to people. Cursor's ids carry their settings in brackets ("claude-sonnet-4-5[thinking=true,
// context=200k]"); the id is what's saved and sent, the label is what's shown. Shared by the gateway and the app.

/** `claude-sonnet-4-5[thinking=true,context=200k]` → `claude-sonnet-4-5 (thinking, context 200k)`; others as they are. */
export function modelLabel(id: string): string {
  if (id === "default[]") return "Auto"; // Cursor's own choice
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

/** Options for a picker: each id with its label, or with the id itself where two labels would read the same. */
export function modelOptions(ids: readonly string[]): { value: string; label: string }[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(modelLabel(id), (counts.get(modelLabel(id)) ?? 0) + 1);
  return ids.map((id) => {
    const label = modelLabel(id);
    return { value: id, label: (counts.get(label) ?? 0) > 1 ? id : label };
  });
}

/** Cursor's own "Auto" entry repeats the pickers' "Default" (the provider chooses), so lists leave it out. */
export function listedModels(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== "default[]");
}
