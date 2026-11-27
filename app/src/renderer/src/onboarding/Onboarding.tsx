// The first-run flow: welcome, pick a provider and model (with the key if one is needed), and name the bot. It
// saves everything on the main bot in one change at the end, so leaving early changes nothing.
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ProviderId, ProviderSummary, PublicBot } from "../../../../../server/src/types.ts";
import { call } from "../gateway.ts";
import { Select } from "../settings/controls.tsx";
import { checkServerAddress, takesServerAddress } from "../settings/settings-state.ts";
import {
  allowsDefaultModel,
  canContinue,
  checkBotName,
  firstModel,
  firstProvider,
  MAX_BOT_NAME,
  needsKey,
  showKeyField,
  usableProviders,
} from "./onboarding-state.ts";
import "./onboarding.css";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Step = "welcome" | "model" | "name";
type Test = { state: "idle" | "testing" } | { state: "ok"; models: string[] } | { state: "error"; error: string };

export function Onboarding({
  bot,
  onDone,
  onSkip,
}: {
  bot: PublicBot;
  /** Everything is saved on the bot; the caller marks onboarding done. */
  onDone(bot: PublicBot): Promise<void>;
  onSkip(): void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [providers, setProviders] = useState<ProviderSummary[]>();
  const [providerError, setProviderError] = useState<string>();
  const [provider, setProvider] = useState<ProviderId>();
  const [server, setServer] = useState(bot.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [test, setTest] = useState<Test>({ state: "idle" });
  const [model, setModel] = useState("");
  const [name, setName] = useState(bot.name);
  const [nameError, setNameError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      const list = await call("listProviders");
      setProviders(list);
      setProviderError(undefined);
      return list;
    } catch (err) {
      setProviderError(`Couldn't list providers: ${message(err)}`);
      return undefined;
    }
  }, []);

  /** Lists the providers and preselects one; also the retry when listing failed. */
  const startProviders = useCallback(async () => {
    const list = await loadProviders();
    if (list) setProvider((current) => current ?? firstProvider(list, bot.provider));
  }, [loadProviders, bot.provider]);
  useEffect(() => void startProviders(), [startProviders]);

  const chosen = providers?.find((p) => p.id === provider);

  const pickProvider = (id: ProviderId) => {
    setProvider(id);
    // Each provider has its own server: the bot's saved one belongs only to its own provider.
    setServer(id === bot.provider ? (bot.baseUrl ?? "") : "");
    setKey("");
    setModel("");
    setTest({ state: "idle" });
  };

  /** Saves a typed key, then asks the provider for its models: the proof that it works. */
  const connect = async () => {
    if (!chosen) return;
    const address = checkServerAddress(server);
    if (takesServerAddress(chosen.id) && !address.ok) return setTest({ state: "error", error: address.error });
    const baseUrl = takesServerAddress(chosen.id) && address.ok ? address.url : undefined;
    const typed = key.trim();
    setKey(""); // out of the page at once, whatever happens next
    setTest({ state: "testing" });
    try {
      if (typed) {
        await call("setKey", chosen.id, typed);
        await loadProviders();
      }
      const result = await call("testProvider", chosen.id, baseUrl);
      if (!result.ok) return setTest({ state: "error", error: result.error });
      setProviderError(undefined); // an earlier listing failure is old news once the provider answers
      setTest({ state: "ok", models: result.models });
      setModel(firstModel(result.models, bot.provider === chosen.id ? bot.model : undefined));
    } catch (err) {
      setTest({ state: "error", error: message(err) });
    }
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    const checked = checkBotName(name);
    if (!checked.ok) return setNameError(checked.error);
    if (!chosen) return;
    setSaving(true);
    setNameError(undefined);
    try {
      const address = checkServerAddress(server);
      // Empty means the usual address: sent as "" so an old saved one is cleared, as in Settings.
      const baseUrl = takesServerAddress(chosen.id) && address.ok ? { baseUrl: address.url ?? "" } : {};
      const updated = await call("updateBot", bot.id, { name: checked.name, provider: chosen.id, model, ...baseUrl });
      await onDone(updated);
    } catch (err) {
      setNameError(`Couldn't save: ${message(err)}`);
      setSaving(false);
    }
  };

  return (
    <main className="onboarding" aria-labelledby="onboarding-title">
      <div className="onboarding-step" key={step}>
        {step === "welcome" && <Welcome onStart={() => setStep("model")} />}
        {step === "model" && (
          <ModelStep
            providers={providers}
            providerError={providerError}
            chosen={chosen}
            server={server}
            keyDraft={key}
            test={test}
            model={model}
            onProvider={pickProvider}
            onServer={(s) => {
              setServer(s);
              setTest({ state: "idle" });
            }}
            onKey={setKey}
            onConnect={() => void connect()}
            onRetryProviders={() => void startProviders()}
            onModel={setModel}
            onBack={() => setStep("welcome")}
            onNext={() => setStep("name")}
          />
        )}
        {step === "name" && (
          <form className="onboarding-form" onSubmit={(e) => void finish(e)} noValidate>
            <Face />
            <h1 id="onboarding-title" className="onboarding-title">
              What would you like to call me?
            </h1>
            <p className="onboarding-lead">You can always change this later.</p>
            <label className="onboarding-field">
              <span className="onboarding-label">Name</span>
              <input
                className="onboarding-input"
                value={name}
                maxLength={MAX_BOT_NAME}
                spellCheck={false}
                aria-invalid={nameError !== undefined}
                aria-describedby="onboarding-name-note"
                // biome-ignore lint/a11y/noAutofocus: the only input on this step, reached by pressing Continue.
                autoFocus
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(undefined);
                }}
              />
            </label>
            <p id="onboarding-name-note" className="onboarding-note" data-tone="error" role="alert">
              {nameError}
            </p>
            <div className="onboarding-actions">
              <button type="button" className="button secondary" onClick={() => setStep("model")}>
                Back
              </button>
              <button type="submit" className="button primary" disabled={saving}>
                {saving ? "Saving…" : "Start chatting"}
              </button>
            </div>
          </form>
        )}
      </div>
      <button type="button" className="onboarding-skip" onClick={onSkip}>
        Set up later
      </button>
    </main>
  );
}

/** The bot's face: a stand-in until the product's own mascot arrives (#32). */
function Face() {
  return (
    <span className="onboarding-face" aria-hidden="true">
      <span className="onboarding-eye" />
      <span className="onboarding-eye" />
    </span>
  );
}

function Welcome({ onStart }: { onStart(): void }) {
  return (
    <div className="onboarding-form">
      <div className="onboarding-brand">
        <Face />
        <h1 id="onboarding-title" className="onboarding-wordmark">
          SmartyPrompts
        </h1>
      </div>
      <p className="onboarding-tagline">Always-on bots that do real work, with the model you choose.</p>
      <div className="onboarding-actions">
        {/* biome-ignore lint/a11y/noAutofocus: the screen's one action; Enter starts. */}
        <button type="button" className="button primary" autoFocus onClick={onStart}>
          Get started
        </button>
      </div>
    </div>
  );
}

function ModelStep({
  providers,
  providerError,
  chosen,
  server,
  keyDraft,
  test,
  model,
  onProvider,
  onServer,
  onKey,
  onConnect,
  onRetryProviders,
  onModel,
  onBack,
  onNext,
}: {
  providers: ProviderSummary[] | undefined;
  providerError: string | undefined;
  chosen: ProviderSummary | undefined;
  server: string;
  keyDraft: string;
  test: Test;
  model: string;
  onProvider(id: ProviderId): void;
  onServer(server: string): void;
  onKey(key: string): void;
  onConnect(): void;
  onRetryProviders(): void;
  onModel(model: string): void;
  onBack(): void;
  onNext(): void;
}) {
  const ids = { provider: useId(), server: useId(), key: useId(), model: useId(), note: useId() };
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);

  const usable = providers ? usableProviders(providers) : [];
  const testing = test.state === "testing";
  const keyMissing = chosen ? needsKey(chosen) : false;
  // Also after a failed test with a saved key: that key may be the problem, so a new one can be pasted.
  const askKey = chosen ? showKeyField(chosen, test.state === "error") : false;
  const models = test.state === "ok" ? test.models : [];
  const modelOptions = [
    chosen && allowsDefaultModel(chosen)
      ? { value: "", label: "Default" }
      : { value: "", label: "Choose a model", disabled: true },
    ...models.map((m) => ({ value: m, label: m })),
  ];
  const note =
    providerError ??
    (test.state === "testing"
      ? "Connecting…"
      : test.state === "error"
        ? test.error
        : test.state === "ok"
          ? `Connected. ${test.models.length} models available.`
          : keyMissing
            ? "Paste your key, then connect. It's stored in your computer's keychain."
            : "Connect to check it works.");
  const tone = providerError || test.state === "error" ? "error" : test.state === "ok" ? "ok" : undefined;

  return (
    <form
      className="onboarding-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!providers) onRetryProviders();
        else if (chosen && canContinue(chosen, test.state === "ok", model)) onNext();
        else if (!testing) onConnect();
      }}
    >
      <h1 id="onboarding-title" className="onboarding-title">
        Pick a model
      </h1>
      <p className="onboarding-lead">Your bot thinks with it. You can change it any time in Settings.</p>

      <div className="onboarding-fields">
        <div className="onboarding-field">
          <label className="onboarding-label" htmlFor={ids.provider}>
            Provider
          </label>
          <Select<ProviderId>
            id={ids.provider}
            ref={first}
            value={chosen?.id ?? ("" as ProviderId)}
            options={
              usable.length
                ? usable.map((p) => ({ value: p.id, label: p.local ? `${p.label} · local` : p.label }))
                : [{ value: "" as ProviderId, label: providers ? "No providers" : "Loading…", disabled: true }]
            }
            disabled={testing || !usable.length}
            onChange={onProvider}
          />
        </div>

        {chosen && takesServerAddress(chosen.id) && (
          <div className="onboarding-field">
            <label className="onboarding-label" htmlFor={ids.server}>
              Server address
            </label>
            <input
              id={ids.server}
              className="onboarding-input"
              value={server}
              placeholder="Leave empty for this computer"
              spellCheck={false}
              disabled={testing}
              onChange={(e) => onServer(e.target.value)}
            />
          </div>
        )}

        {askKey && (
          <div className="onboarding-field">
            <label className="onboarding-label" htmlFor={ids.key}>
              API key
            </label>
            <input
              id={ids.key}
              className="onboarding-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={keyMissing ? "Paste your key" : "Paste a new key, or connect again"}
              value={keyDraft}
              disabled={testing}
              onChange={(e) => onKey(e.target.value)}
            />
          </div>
        )}

        {test.state === "ok" && (
          <div className="onboarding-field">
            <label className="onboarding-label" htmlFor={ids.model}>
              Model
            </label>
            {models.length === 0 && chosen && !allowsDefaultModel(chosen) ? (
              // Nothing listed and no default to fall back on: the model has to be named.
              <input
                id={ids.model}
                className="onboarding-input"
                value={model}
                placeholder="Type the model's exact name"
                spellCheck={false}
                onChange={(e) => onModel(e.target.value.trim())}
              />
            ) : (
              <Select id={ids.model} value={model} options={modelOptions} onChange={onModel} />
            )}
          </div>
        )}
      </div>

      <p id={ids.note} className="onboarding-note" data-tone={tone} role="status">
        {note}
      </p>

      <div className="onboarding-actions">
        <button type="button" className="button secondary" onClick={onBack}>
          Back
        </button>
        {!providers && providerError ? (
          <button type="button" className="button primary" onClick={onRetryProviders}>
            Try again
          </button>
        ) : test.state === "ok" ? (
          <button type="submit" className="button primary" disabled={!chosen || !canContinue(chosen, true, model)}>
            Continue
          </button>
        ) : (
          <button
            type="submit"
            className="button primary"
            disabled={!chosen || testing || (keyMissing && !keyDraft.trim())}
          >
            {testing ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </form>
  );
}
