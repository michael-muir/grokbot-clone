// Settings › Models & keys: each bot's provider, model and server; each provider's API key. A key typed here goes
// straight to the gateway (and the OS keychain) and is cleared from the page; it's never shown or read back.
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ProviderId, ProviderSummary, PublicBot } from "../../../../../server/src/types.ts";
import { call } from "../gateway.ts";
import { Row, Section, Select } from "./controls.tsx";
import {
  checkServerAddress,
  isPlaceholder,
  keyStatus,
  modelChoices,
  providerHint,
  takesServerAddress,
} from "./settings-state.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Models = { state: "idle" | "loading" } | { state: "ok"; models: string[] } | { state: "error"; error: string };
type Note = { tone: "ok" | "error"; text: string } | undefined;

export function ModelsPage({
  bots,
  initialBotId,
  onBotChanged,
  onProvidersChanged,
}: {
  bots: readonly PublicBot[];
  initialBotId: string | undefined;
  onBotChanged(bot: PublicBot): void;
  /** A key was saved or removed: the app's own provider list should follow. */
  onProvidersChanged(providers: ProviderSummary[]): void;
}) {
  const ids = { bot: useId(), provider: useId(), model: useId(), server: useId(), key: useId() };
  const [botId, setBotId] = useState(initialBotId);
  // Falls back at render time, so bots that arrive after the page opened still show.
  const bot = bots.find((b) => b.id === botId) ?? bots[0];
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [models, setModels] = useState<Models>({ state: "idle" });
  const [note, setNote] = useState<Note>();
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState(bot?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [customModel, setCustomModel] = useState("");

  const refreshProviders = useCallback(async () => {
    try {
      const list = await call("listProviders");
      setProviders(list);
      onProvidersChanged(list);
    } catch (err) {
      setNote({ tone: "error", text: `Couldn't list providers: ${message(err)}` });
    }
  }, [onProvidersChanged]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per page open; later refreshes follow key changes.
  useEffect(() => void refreshProviders(), []);

  const provider = providers.find((p) => p.id === bot?.provider);

  // Only what the list depends on, as plain values: a new bot object after saving a model mustn't reload it.
  const listProvider = provider ? bot?.provider : undefined;
  const listBaseUrl = bot?.baseUrl;
  const keyMissing = provider ? provider.needsKey && !provider.configured : false;
  /** Bumped by every listing; a reply that isn't the latest is dropped (a slow provider can't overwrite a fast one). */
  const latest = useRef(0);

  const loadModels = useCallback(async () => {
    const ticket = ++latest.current;
    if (!listProvider) return;
    if (keyMissing) {
      setModels({ state: "error", error: "Add a key below to see this provider's models." });
      return;
    }
    setModels({ state: "loading" });
    try {
      const test = await call("testProvider", listProvider, listBaseUrl);
      if (ticket !== latest.current) return;
      setModels(test.ok ? { state: "ok", models: test.models } : { state: "error", error: test.error });
    } catch (err) {
      if (ticket === latest.current) setModels({ state: "error", error: message(err) });
    }
  }, [listProvider, listBaseUrl, keyMissing]);
  useEffect(() => void loadModels(), [loadModels]);

  // A different bot or provider: start from what's saved for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching bot or provider is the trigger, not a value read.
  useEffect(() => {
    setServer(bot?.baseUrl ?? "");
    setKey("");
    setCustomModel("");
    setNote(undefined);
  }, [bot?.id, bot?.provider, bot?.baseUrl]);

  /** Runs one change, showing what happened under the section. */
  const run = async (what: () => Promise<string | undefined>) => {
    setBusy(true);
    setNote(undefined);
    try {
      const done = await what();
      if (done) setNote({ tone: "ok", text: done });
    } catch (err) {
      setNote({ tone: "error", text: message(err) });
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Parameters<typeof call<"updateBot">>[2]) =>
    run(async () => {
      if (!bot) return undefined;
      onBotChanged(await call("updateBot", bot.id, patch));
      return undefined;
    });

  if (!bot) return <p className="settings-description">There are no bots yet.</p>;

  const providerOptions = providers.map((p) => {
    const hint = providerHint(p);
    return { value: p.id, label: hint ? `${p.label} · ${hint}` : p.label, disabled: isPlaceholder(p) };
  });
  const listed = models.state === "ok" ? models.models : [];
  const modelOptions = [
    { value: "", label: "Default" },
    ...modelChoices(listed, bot.model).map((m) => ({ value: m, label: m })),
  ];

  const saveServer = () => {
    const checked = checkServerAddress(server);
    if (!checked.ok) return setNote({ tone: "error", text: checked.error });
    if ((checked.url ?? "") === (bot.baseUrl ?? "")) return;
    void update({ baseUrl: checked.url ?? "" });
  };

  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    const typed = key.trim();
    if (!typed || !provider) return;
    setKey(""); // out of the page at once, whatever happens next
    void run(async () => {
      await call("setKey", provider.id, typed);
      await refreshProviders();
      return `Key saved for ${provider.label}.`;
    });
  };

  const testKey = () =>
    run(async () => {
      if (!provider) return undefined;
      const ticket = ++latest.current;
      const result = await call("testProvider", provider.id, bot.baseUrl);
      if (!result.ok) throw new Error(result.error);
      if (ticket === latest.current) setModels({ state: "ok", models: result.models });
      return `${provider.label} works: ${result.models.length} models available.`;
    });

  const removeKey = () =>
    run(async () => {
      if (!provider) return undefined;
      await call("deleteKey", provider.id);
      await refreshProviders();
      return `Key removed for ${provider.label}.`;
    });

  return (
    <>
      {bots.length > 1 && (
        <Section title="Bot">
          <Row label="Settings for" htmlFor={ids.bot}>
            <Select
              id={ids.bot}
              value={bot.id}
              options={bots.map((b) => ({ value: b.id, label: b.name }))}
              onChange={setBotId}
            />
          </Row>
        </Section>
      )}

      <Section title="Model">
        <Row label="Provider" htmlFor={ids.provider}>
          <Select<ProviderId>
            id={ids.provider}
            value={bot.provider}
            options={providerOptions.length ? providerOptions : [{ value: bot.provider, label: bot.provider }]}
            disabled={busy}
            onChange={(next) => void update({ provider: next })}
          />
        </Row>
        {takesServerAddress(bot.provider) && (
          <Row
            label="Server address"
            description="Leave empty for the usual address on this computer."
            htmlFor={ids.server}
          >
            <input
              id={ids.server}
              className="settings-input"
              value={server}
              placeholder="http://127.0.0.1:11434/v1"
              spellCheck={false}
              onChange={(e) => setServer(e.target.value)}
              onBlur={saveServer}
              onKeyDown={(e) => {
                // Saving happens on blur only, so Enter then a click elsewhere can't save twice.
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </Row>
        )}
        <Row
          label="Model"
          htmlFor={ids.model}
          description={
            models.state === "loading"
              ? "Loading models…"
              : models.state === "error"
                ? models.error
                : "Default lets the provider choose."
          }
        >
          <div className="settings-inline">
            <Select
              id={ids.model}
              value={bot.model ?? ""}
              options={modelOptions}
              disabled={busy}
              onChange={(model) => void update({ model })}
            />
            <button type="button" className="button secondary small" disabled={busy} onClick={() => void loadModels()}>
              Refresh
            </button>
          </div>
        </Row>
        {models.state === "error" && (
          <Row label="Model name" description="If the list won't load, type the model's exact name.">
            <form
              className="settings-inline"
              onSubmit={(e) => {
                e.preventDefault();
                if (customModel.trim()) void update({ model: customModel.trim() });
              }}
            >
              <input
                className="settings-input"
                aria-label="Model name"
                value={customModel}
                spellCheck={false}
                onChange={(e) => setCustomModel(e.target.value)}
              />
              <button type="submit" className="button secondary small" disabled={busy || !customModel.trim()}>
                Use
              </button>
            </form>
          </Row>
        )}
      </Section>

      {provider?.needsKey && (
        <Section title={`${provider.label} API key`}>
          <Row label="Status" description="Keys are stored in your computer's keychain and never shown again.">
            <span className="settings-value">{keyStatus(provider)}</span>
          </Row>
          <Row label={provider.keySource ? "Replace key" : "Add key"} htmlFor={ids.key}>
            <form className="settings-inline" onSubmit={saveKey}>
              <input
                id={ids.key}
                className="settings-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste your key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button type="submit" className="button primary small" disabled={busy || !key.trim()}>
                Save
              </button>
            </form>
          </Row>
          <Row label="Check the key">
            <div className="settings-inline">
              <button type="button" className="button secondary small" disabled={busy} onClick={() => void testKey()}>
                Test
              </button>
              {provider.keySource === "keychain" && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => void removeKey()}
                >
                  Remove
                </button>
              )}
            </div>
          </Row>
        </Section>
      )}

      <p className="settings-note" role="status" data-tone={note?.tone}>
        {note?.text}
      </p>
    </>
  );
}
