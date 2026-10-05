import { app } from "./state.js";
import { apiErrorMessage, fetchWithTimeout, requestJson } from "./api.js";
import { renewSession } from "./session.js";
import { artworkCache, artworkMisses, setArtwork } from "./dom.js";
import { t } from "./i18n.js";

const studio = () => {
  let dialog = document.querySelector("#portrait-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "portrait-dialog";
    dialog.className = "character-builder-dialog portrait-dialog";
    dialog.setAttribute("aria-labelledby", "portrait-dialog-title");
    document.body.append(dialog);
  }
  return dialog;
};
const node = (tag, className, content) => {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined) result.textContent = content;
  return result;
};
const button = (label, action, primary = false) => {
  const result = node("button", `ui-control${primary ? " primary" : ""}`, label);
  result.type = "button";
  result.addEventListener("click", action);
  return result;
};
const refreshPortrait = (characterId) => {
  for (const ending of ["portrait", "candidate"]) {
    const url = `/api/activity/characters/${encodeURIComponent(characterId)}/portrait${ending === "candidate" ? "/candidate" : ""}`;
    const cached = artworkCache.get(url);
    if (cached) URL.revokeObjectURL(cached.objectUrl);
    artworkCache.delete(url);
    artworkMisses.delete(url);
  }
};

async function longRequest(url, options = {}, renewed = false) {
  const headers = new Headers(options.headers);
  if (app.sessionToken) headers.set("Authorization", `Bearer ${app.sessionToken}`);
  const response = await fetchWithTimeout(url, { ...options, headers, cache: "no-store" }, 105000);
  if (response.status === 401 && !renewed && app.discordSdk && await renewSession().then(() => true, () => false)) return longRequest(url, options, true);
  if (response.ok && options.binary) return response.blob();
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error === "portraitTooLarge" ? t("activity.portrait.error.tooLarge") : payload.error?.startsWith("portrait_") ? t(`activity.portrait.error.${payload.error.slice(9)}`, { minutes: payload.retryAfterMinutes ?? 1 }) : apiErrorMessage(payload.error));
    throw error;
  }
  return payload;
}

const galleries = new Map();

export async function openPortraitStudio(characterId, name, onChanged = () => {}, draft = null) {
  const demo = draft?.previewMode === true;
  const base = `/api/activity/characters/${encodeURIComponent(characterId)}/portrait`;
  const options = demo ? { canPaint: true, canUpload: true, hasCandidate: false } : await requestJson(base + "/options");
  let gallery = galleries.get(characterId);
  if (!gallery) {
    gallery = { items: [], selected: null, style: draft?.style ?? "painterly", note: draft?.note ?? "", reference: null };
    galleries.set(characterId, gallery);
  }
  const fingerprint = JSON.stringify(draft?.build ?? null);
  if (draft?.mode === "upload" && draft.file && !gallery.items.some((item) => item.original === draft.file)) {
    const original = { id: ++candidateSequence, blob: draft.file, original: draft.file, url: URL.createObjectURL(draft.file), fingerprint, style: "original" };
    gallery.items.push(original); gallery.selected = original.id; gallery.reference = draft.file;
  }
  const dialog = studio();
  dialog.replaceChildren();
  const header = node("header", "builder-header");
  const heading = node("div");
  const title = node("h2", "", t("activity.portrait.title", { name })); title.id = "portrait-dialog-title";
  heading.append(title, node("p", "", t("activity.portrait.galleryIntro")));
  const close = button("×", () => dialog.close()); close.setAttribute("aria-label", t("activity.portrait.close"));
  header.append(heading, close);
  const preview = node("div", "portrait-studio-preview");
  const image = node("img"); image.hidden = true;
  const fallback = node("span", "", t("activity.portrait.noPortrait"));
  preview.append(image, fallback);
  const history = node("div", "portrait-gallery"); history.setAttribute("aria-label", t("activity.portrait.gallery"));
  const provenance = node("p", "builder-help"); provenance.setAttribute("aria-live", "polite");
  const styleLabel = node("label", "portrait-studio-field");
  const style = node("select");
  for (const id of ["painterly", "ink", "watercolor", "realistic"]) {
    const option = node("option", "", t(`activity.portrait.style.${id}`)); option.value = id; style.append(option);
  }
  style.value = gallery.style;
  styleLabel.append(node("span", "", t("activity.portrait.styleLabel")), style);
  const noteLabel = node("label", "portrait-studio-field");
  const note = node("textarea"); note.maxLength = 200; note.placeholder = t("activity.portrait.notePlaceholder"); note.value = gallery.note;
  noteLabel.append(node("span", "", t("activity.portrait.noteLabel")), note);
  style.addEventListener("change", () => { gallery.style = style.value; });
  note.addEventListener("input", () => { gallery.note = note.value; });
  const controls = node("div", "portrait-studio-actions");
  const feedback = node("p", "portrait-studio-feedback"); feedback.setAttribute("role", "status");
  let busy = false;
  const selected = () => gallery.items.find((item) => item.id === gallery.selected);
  const draw = () => {
    const item = selected();
    if (item) {
      image.dataset.source = ""; image.src = item.url; image.alt = t("activity.hero.portraitAlt", { name });
      image.hidden = false; fallback.hidden = true;
    } else {
      image.hidden = true; fallback.hidden = false;
      if (!demo) void setArtwork(image, fallback, base, t("activity.hero.portraitAlt", { name }));
    }
    provenance.textContent = item ? (item.fingerprint !== fingerprint ? t("activity.portrait.earlierDetails") : t("activity.portrait.currentDetails")) + " · " + t(`activity.portrait.style.${item.style}`) : "";
    history.replaceChildren();
    gallery.items.forEach((candidate, index) => {
      const thumbnail = button(t("activity.portrait.choice", { number: index + 1 }), () => { gallery.selected = candidate.id; draw(); });
      thumbnail.classList.add("portrait-gallery-choice");
      thumbnail.setAttribute("aria-pressed", String(candidate.id === gallery.selected));
      thumbnail.disabled = busy;
      const thumb = node("img"); thumb.src = candidate.url; thumb.alt = "";
      thumbnail.prepend(thumb); history.append(thumbnail);
    });
    use.disabled = busy || !item;
    discard.disabled = busy || !item;
  };
  const run = async (work) => {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
    feedback.textContent = t("activity.portrait.working");
    try { await work(); feedback.textContent = demo ? t("activity.portrait.demoGallery") : ""; }
    catch (error) { feedback.textContent = error instanceof Error ? error.message : t("activity.portrait.error.failed"); }
    finally {
      busy = false;
      dialog.querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
      draw();
    }
  };
  const addCandidate = async () => {
    let blob;
    let url;
    if (demo) {
      url = gallery.items.length % 2 ? "/previews/pip.jpg" : "/previews/mira.jpg";
    } else {
      blob = await longRequest(base + "/candidate", { binary: true });
      url = URL.createObjectURL(blob);
    }
    const item = { id: ++candidateSequence, blob, url, fingerprint, style: style.value };
    gallery.items.push(item); gallery.selected = item.id;
  };
  const generate = () => void run(async () => {
    if (!demo) {
      const params = new URLSearchParams({ style: style.value, note: note.value.trim() });
      const reference = gallery.reference;
      await longRequest(base + (reference ? "/upload?" : "/generate?") + params, { method: "POST", ...(reference ? { headers: { "Content-Type": reference.type }, body: reference } : {}) });
    }
    await addCandidate();
  });
  const paint = button(t(gallery.reference ? "activity.portrait.reimagine" : "activity.portrait.generateAnother"), generate);
  if (options.canPaint || options.canUpload) controls.append(paint);
  if (options.canUpload) {
    const file = node("input"); file.type = "file"; file.accept = "image/png,image/jpeg,image/webp";
    const reference = node("label", "portrait-studio-field portrait-reference");
    reference.append(node("span", "", t("activity.portrait.photoReference")), file);
    const referenceStatus = node("p", "builder-help", gallery.reference?.name ?? t("activity.portrait.photoHelp"));
    referenceStatus.setAttribute("aria-live", "polite");
    file.addEventListener("change", () => {
      const chosen = file.files?.[0]; if (!chosen) return;
      if (chosen.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(chosen.type)) {
        feedback.textContent = t(chosen.size > 8 * 1024 * 1024 ? "activity.portrait.error.tooLarge" : "activity.portrait.error.badType"); file.value = ""; return;
      }
      gallery.reference = chosen; referenceStatus.textContent = chosen.name;
    });
    reference.append(referenceStatus);
    const clearReference = button(t("activity.portrait.clearReference"), () => { gallery.reference = null; file.value = ""; referenceStatus.textContent = t("activity.portrait.photoHelp"); });
    clearReference.classList.add("portrait-discard");
    controls.prepend(reference, clearReference);
  }
  const use = button(t("activity.portrait.use"), () => void run(async () => {
    const item = selected(); if (!item) return;
    if (!demo) {
      await longRequest(base, { method: "PUT", headers: { "Content-Type": item.blob.type }, body: item.blob });
      await requestJson(base + "/discard", { method: "POST" });
      refreshPortrait(characterId); onChanged();
    }
    dialog.close();
  }), true);
  const discard = button(t("activity.portrait.discardChoice"), () => {
    const item = selected(); if (!item || busy) return;
    gallery.items = gallery.items.filter((candidate) => candidate.id !== item.id);
    if (item.blob) URL.revokeObjectURL(item.url);
    gallery.selected = gallery.items.at(-1)?.id ?? null;
    draw();
  });
  discard.classList.add("portrait-discard");
  const footer = node("footer", "portrait-navigation");
  if (draft?.onBack) footer.append(button(t("activity.portrait.backToSheet"), () => { dialog.close(); draft.onBack(); }));
  const finish = button(t("activity.portrait.finishShort"), () => dialog.close());
  finish.classList.add("portrait-finish");
  footer.append(finish, use);
  const body = node("div", "portrait-gallery-layout");
  const artwork = node("div"); artwork.append(preview, history, provenance, discard);
  const settings = node("div"); settings.append(styleLabel, noteLabel, controls, feedback);
  body.append(artwork, settings);
  dialog.append(header, body, footer);
  dialog.showModal();
  draw();
  if (options.hasCandidate && gallery.items.length === 0) await run(addCandidate);
  if (demo) feedback.textContent = t("activity.portrait.demoGallery");
  else if (!options.canPaint && !options.canUpload) feedback.textContent = t("activity.portrait.unavailable");
}
let candidateSequence = 0;
