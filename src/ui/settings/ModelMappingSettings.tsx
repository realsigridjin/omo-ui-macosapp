import { useCallback, useEffect, useState } from "react";
import { MODEL_MAPPING_NAMES } from "../../../shared/ipc";
import type { ModelMapping, ModelMappingKind, ModelRung } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { errorMessage } from "./diagnostics";
import { SettingsCard, SettingsGroup } from "./SettingsCard";
import css from "./SettingsCard.module.css";
import mapCss from "./ModelMappingSettings.module.css";

const REASONING = ["low", "medium", "high", "xhigh", "max"] as const;

function ChainRow({ kind, name, rungs, modelIds, onSave }: {
  kind: ModelMappingKind;
  name: string;
  rungs: ModelRung[] | undefined;
  modelIds: string[];
  onSave(kind: ModelMappingKind, name: string, rungs: ModelRung[] | null): void;
}) {
  const t = useT();
  const chain = rungs ?? [];
  const save = (next: ModelRung[]): void => onSave(kind, name, next.length === 0 ? null : next);
  const move = (from: number, to: number): void => {
    const next = [...chain];
    const [rung] = next.splice(from, 1);
    if (rung !== undefined) next.splice(to, 0, rung);
    save(next);
  };
  return (
    <div className={mapCss.row} data-testid={TESTID.modelMappingRow} data-kind={kind} data-name={name} data-custom={rungs !== undefined || undefined}>
      <div className={mapCss.head}>
        <span className={mapCss.name}>{name}</span>
        <span className={css.badge}>{rungs === undefined ? t("shell.settings.mapping.builtin") : t("shell.settings.mapping.custom")}</span>
        {rungs !== undefined && (
          <button type="button" className={css.textButton} data-testid={TESTID.modelMappingReset} onClick={() => onSave(kind, name, null)}>
            {t("shell.settings.mapping.reset")}
          </button>
        )}
      </div>
      {chain.length > 0 && (
        <ol className={mapCss.chain}>
          {chain.map((rung, index) => (
            <li key={`${rung.model}-${index}`} className={mapCss.rung} data-testid={TESTID.modelMappingRung}>
              <span className={mapCss.order}>{index + 1}</span>
              <code className={mapCss.model} title={rung.model}>{rung.model}</code>
              <select
                className={mapCss.reasoning}
                aria-label={t("shell.settings.mapping.reasoning", { model: rung.model })}
                value={rung.reasoning ?? ""}
                onChange={(event) => save(chain.map((entry, at) => (at === index ? { ...entry, reasoning: event.target.value === "" ? null : event.target.value } : entry)))}
              >
                <option value="">{t("shell.settings.mapping.reasoningDefault")}</option>
                {REASONING.map((level) => <option key={level} value={level}>{level}</option>)}
                {rung.reasoning !== null && !REASONING.some((level) => level === rung.reasoning) && <option value={rung.reasoning}>{rung.reasoning}</option>}
              </select>
              <button type="button" className={mapCss.icon} aria-label={t("shell.settings.mapping.up")} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button>
              <button type="button" className={mapCss.icon} aria-label={t("shell.settings.mapping.down")} disabled={index === chain.length - 1} onClick={() => move(index, index + 1)}>↓</button>
              <button type="button" className={mapCss.icon} aria-label={t("shell.settings.mapping.remove", { model: rung.model })} data-testid={TESTID.modelMappingRemove}
                onClick={() => save(chain.filter((_, at) => at !== index))}>×</button>
            </li>
          ))}
        </ol>
      )}
      <select
        className={css.select}
        data-testid={TESTID.modelMappingAdd}
        aria-label={t("shell.settings.mapping.add", { name })}
        value=""
        onChange={(event) => {
          if (event.target.value !== "") save([...chain, { model: event.target.value, reasoning: null }]);
        }}
      >
        <option value="">{chain.length === 0 ? t("shell.settings.mapping.addFirst") : t("shell.settings.mapping.addFallback")}</option>
        {modelIds.filter((id) => !chain.some((rung) => rung.model === id)).map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
    </div>
  );
}

/**
 * Research agent and task category model chains from `~/.omo/omo.jsonc`. Each change writes the file at once;
 * omo reloads it, so the next task or subagent uses the new chain.
 */
export function ModelMappingSettings() {
  const t = useT();
  const models = useAppSelector((state) => state.models);
  const [mapping, setMapping] = useState<ModelMapping | null>(null);
  const [error, setError] = useState<string | null>(null);
  // omo.jsonc names models as provider/model; ids without a provider cannot be written there.
  const modelIds = models.filter((model) => !model.hidden && model.id.includes("/")).map((model) => model.id);
  useEffect(() => {
    let live = true;
    window.omo.readModelMapping().then(
      (loaded) => { if (live) { setMapping(loaded); setError(null); } },
      (reason: unknown) => { if (live) setError(errorMessage(reason)); },
    );
    return () => { live = false; };
  }, []);
  const save = useCallback((kind: ModelMappingKind, name: string, rungs: ModelRung[] | null): void => {
    window.omo.setModelChain(kind, name, rungs).then(
      (next) => { setMapping(next); setError(null); },
      (reason: unknown) => setError(errorMessage(reason)),
    );
  }, []);
  const section = (kind: ModelMappingKind, title: string, intro: string) => {
    const configured = mapping?.[kind] ?? {};
    const names = [...MODEL_MAPPING_NAMES[kind], ...Object.keys(configured).filter((name) => !MODEL_MAPPING_NAMES[kind].includes(name)).sort()];
    return (
      <>
        <SettingsGroup title={title} intro={intro} />
        <SettingsCard testId={kind === "agents" ? TESTID.modelMappingAgents : TESTID.modelMappingCategories}>
          {names.map((name) => <ChainRow key={name} kind={kind} name={name} rungs={configured[name]} modelIds={modelIds} onSave={save} />)}
        </SettingsCard>
      </>
    );
  };
  return (
    <>
      {error !== null && <p className={css.error} role="alert">{t("shell.settings.mapping.error", { message: error })}</p>}
      {mapping !== null && (
        <>
          {section("agents", t("shell.settings.mapping.agents"), t("shell.settings.mapping.agentsHint"))}
          {section("categories", t("shell.settings.mapping.categories"), t("shell.settings.mapping.categoriesHint"))}
          <p className={css.muted}>{t("shell.settings.mapping.file")} <code className={css.mono}>{mapping.path}</code></p>
        </>
      )}
    </>
  );
}
