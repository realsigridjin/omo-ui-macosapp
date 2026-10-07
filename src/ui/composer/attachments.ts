import type { UserInput } from "../../../shared/protocol";

/** A composer attachment: a file on disk, or a pasted/dropped bitmap held as a data URL until it is saved to a file. */
export type ImageInput = Extract<UserInput, { type: "image" | "localImage" }>;
export const IMAGE_LIMIT = 10;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

/**
 * omo's app-server rejects image and localImage input items, so attachments travel as file paths in a trailing text
 * block that the model opens with its read tool. The header line is what `splitAttachments` recognises.
 */
export const ATTACHMENT_HEADER = "Attached images (open each file with the read tool):";

export function isImageFile(name: string, mime = ""): boolean {
  return /^image\/(png|jpeg|gif|webp)$/i.test(mime) || IMAGE_EXTENSIONS.includes(name.split(".").at(-1)?.toLowerCase() ?? "");
}
export function capImages(current: readonly ImageInput[], added: readonly ImageInput[]): ImageInput[] {
  return [...current, ...added].slice(0, IMAGE_LIMIT);
}

/** The single text input omo accepts: the trimmed-or-empty text followed by the attachment block when there are paths. */
export function messageInput(text: string, imagePaths: readonly string[]): UserInput[] {
  const body = text.trim() === "" ? "" : text;
  const block = imagePaths.length === 0 ? "" : [ATTACHMENT_HEADER, ...imagePaths.map((path) => `- ${path}`)].join("\n");
  return [{ type: "text", text: body === "" ? block : block === "" ? body : `${body}\n\n${block}`, text_elements: [] }];
}

/** Splits a sent message into the user's text and the attached image paths of a trailing attachment block. */
export function splitAttachments(text: string): { text: string; paths: string[] } {
  const index = text.lastIndexOf(ATTACHMENT_HEADER);
  if (index < 0 || (index > 0 && text[index - 1] !== "\n")) return { text, paths: [] };
  const lines = text.slice(index + ATTACHMENT_HEADER.length).split("\n").filter((line) => line !== "");
  if (lines.length === 0 || !lines.every((line) => /^- (?:\/|[A-Za-z]:[\\/]|\\\\)/.test(line))) return { text, paths: [] };
  return { text: text.slice(0, index).replace(/\n+$/, ""), paths: lines.map((line) => line.slice(2)) };
}

export function readImage(file: File): Promise<ImageInput> {
  const path = window.omo.imageFilePath(file);
  if (path !== "") return Promise.resolve({ type: "localImage", path });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.onload = () => resolve({ type: "image", url: String(reader.result) });
    reader.readAsDataURL(file);
  });
}
