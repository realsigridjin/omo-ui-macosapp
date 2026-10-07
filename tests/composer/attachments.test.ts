import { describe, expect, it } from "vitest";
import { ATTACHMENT_HEADER, capImages, isImageFile, messageInput, splitAttachments, type ImageInput } from "../../src/ui/composer/attachments";

describe("attachments", () => {
  it("accepts supported image extensions and clipboard MIME types only", () => {
    for (const name of ["a.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp"]) expect(isImageFile(name)).toBe(true);
    expect(isImageFile("clipboard", "image/png")).toBe(true);
    expect(isImageFile("a.pdf", "application/pdf")).toBe(false);
    expect(isImageFile("a.svg", "image/svg+xml")).toBe(false);
  });
  it("caps the combined draft at ten", () => {
    const image: ImageInput = { type: "image", url: "data:image/png;base64,AA==" };
    expect(capImages(Array(9).fill(image), [image, image])).toHaveLength(10);
  });
  it("sends one text item with the image paths in a trailing attachment block", () => {
    const paths = ["/tmp/a.png", "/Users/me/My Shots/b.jpg"];
    const block = `${ATTACHMENT_HEADER}\n- /tmp/a.png\n- /Users/me/My Shots/b.jpg`;
    expect(messageInput(" \n", paths)).toEqual([{ type: "text", text: block, text_elements: [] }]);
    expect(messageInput("describe", paths)).toEqual([{ type: "text", text: `describe\n\n${block}`, text_elements: [] }]);
    expect(messageInput("describe", [])).toEqual([{ type: "text", text: "describe", text_elements: [] }]);
  });
  it("splits the attachment block back off a sent message", () => {
    const [sent] = messageInput("describe\nthis", ["/tmp/a.png", "/tmp/b c.png"]);
    expect(splitAttachments(sent?.type === "text" ? sent.text : "")).toEqual({ text: "describe\nthis", paths: ["/tmp/a.png", "/tmp/b c.png"] });
    expect(splitAttachments(`${ATTACHMENT_HEADER}\n- /tmp/a.png`)).toEqual({ text: "", paths: ["/tmp/a.png"] });
    const windowsPaths = ["C:\\Users\\me\\My Shots\\a.png", "\\\\server\\share\\b.png"];
    const [windows] = messageInput("Windows images", windowsPaths);
    expect(splitAttachments(windows?.type === "text" ? windows.text : "")).toEqual({ text: "Windows images", paths: windowsPaths });
    for (const text of ["plain", `quote ${ATTACHMENT_HEADER}\n- /tmp/a.png`, `${ATTACHMENT_HEADER}\nnot a path`, `${ATTACHMENT_HEADER}`]) {
      expect(splitAttachments(text), text).toEqual({ text, paths: [] });
    }
  });
});
