import { memo, useId, useState } from "react";
import chipCss from "@deepseek-ai/dsh-client-ui-primitives/src/user-text.module.css";
import type { UserInput } from "../../../shared/protocol";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import a11y from "./a11y.module.css";
import css from "./UserBubble.module.css";
import { projectSkillUserText } from "./skill-text";
import { splitAttachments } from "../composer/attachments";

export interface UserImage {
  key: string;
  src: string;
}

export const NO_IMAGES: readonly UserImage[] = [];

function fileUrl(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}${normalized.slice(2).split("/").map(encodeURIComponent).join("/")}`;
  }
  if (normalized.startsWith("//")) return `file:${normalized.split("/").map(encodeURIComponent).join("/")}`;
  return `file://${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Joins the text inputs of a user message and collects its images: image inputs and the paths of a trailing
 * attachment block (see `splitAttachments`); skills and mentions are not shown.
 */
export function userMessageParts(content: readonly UserInput[]): { text: string; images: readonly UserImage[] } {
  const texts: string[] = [];
  const images: UserImage[] = [];
  content.forEach((input, index) => {
    if (input.type === "text") {
      const { text, paths } = splitAttachments(input.text);
      texts.push(text);
      paths.forEach((path, position) => images.push({ key: `attachment:${index}:${position}`, src: fileUrl(path) }));
    } else if (input.type === "image") images.push({ key: `image:${index}`, src: input.url });
    else if (input.type === "localImage") images.push({ key: `image:${index}`, src: fileUrl(input.path) });
  });
  return { text: texts.filter((text) => text !== "").join("\n"), images: images.length === 0 ? NO_IMAGES : images };
}

function Thumbnail({ src }: { src: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={css.thumbFailed}>{t("conversation.image.failed")}</span>;
  return (
    <img
      className={css.thumb}
      src={src}
      alt={t("conversation.user.image")}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** DSH user bubble: right-aligned text with image thumbnails above it; `sending` marks an optimistic echo. */
export const UserBubble = memo(function UserBubble({
  text,
  images,
  sending = false,
}: {
  text: string;
  images: readonly UserImage[];
  sending?: boolean;
}) {
  const t = useT();
  const { skills, rest, context } = projectSkillUserText(text);
  const [showInstructions, setShowInstructions] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const instructionsId = useId();
  const contextId = useId();
  const contextLabels = {
    "omo-ultrawork-reminder": t("conversation.context.ultrawork"),
    "omo-ulw-loop-pointer": t("conversation.context.loopPointer"),
    "omo-mass-ulw-pointer": t("conversation.context.massPointer"),
    "omo-senpi-ulw-loop": t("conversation.context.loopRun"),
    "system-reminder": t("conversation.context.system"),
  };
  const hasInstructions = skills.some((skill) => skill.body !== null);
  return (
    <div
      className={css.row}
      data-testid={TESTID.userMessage}
      data-sending={sending || undefined}
      aria-busy={sending || undefined}
      data-flow="user"
    >
      <div className={css.stack}>
        {images.length > 0 && (
          <div className={css.attachments}>
            {images.map((image) => (
              <Thumbnail key={image.key} src={image.src} />
            ))}
          </div>
        )}
        {text !== "" && (
          <div className={css.bubble}>
            {skills.length > 0 && (
              <div className={css.skills}>
                {skills.map((skill) => (
                  <span
                    key={skill.name}
                    className={`${chipCss.refChip} ${chipCss.slashChip}`}
                    data-testid={TESTID.skillChip}
                    data-ref-chip="skill"
                    title={skill.location ?? `/skill:${skill.name}`}
                  >
                    {t("conversation.skill.label")} /{skill.name}
                  </span>
                ))}
              </div>
            )}
            {rest}
            {context.length > 0 && (
              <div className={css.instructions}>
                <button
                  type="button"
                  className={`${chipCss.refChip} ${css.contextToggle}`}
                  data-testid={TESTID.omoContextToggle}
                  aria-expanded={showContext}
                  aria-controls={contextId}
                  onClick={() => setShowContext((shown) => !shown)}
                >
                  {t("conversation.context.label")}{context.length > 1 ? ` (${context.length})` : ""}
                </button>
                <div id={contextId} hidden={!showContext} className={css.instructionsPanel} data-testid={TESTID.omoContext}>
                  {context.map((block, index) => (
                    <section key={`${block.tag}:${index}`}>
                      <div className={css.instructionName}>
                        {Object.hasOwn(contextLabels, block.tag)
                          ? contextLabels[block.tag as keyof typeof contextLabels]
                          : block.tag}
                      </div>
                      <pre className={css.instructionBody}>{block.body}</pre>
                    </section>
                  ))}
                </div>
              </div>
            )}
            {hasInstructions && (
              <div className={css.instructions}>
                <button
                  type="button"
                  className={css.instructionsToggle}
                  data-testid={TESTID.skillBodyToggle}
                  aria-expanded={showInstructions}
                  aria-controls={instructionsId}
                  onClick={() => setShowInstructions((shown) => !shown)}
                >
                  {t(showInstructions ? "conversation.skill.hideInstructions" : "conversation.skill.showInstructions")}
                </button>
                <div id={instructionsId} hidden={!showInstructions} className={css.instructionsPanel}>
                  {skills.filter((skill) => skill.body !== null).map((skill) => (
                    <section key={skill.name} data-testid={TESTID.skillBody}>
                      <div className={css.instructionName}>{skill.name}</div>
                      <div className={css.instructionLocation}>{skill.location}</div>
                      <pre className={css.instructionBody}>{skill.body}</pre>
                    </section>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {sending && <span className={a11y.visuallyHidden}>{t("conversation.user.sending")}</span>}
      </div>
    </div>
  );
});
