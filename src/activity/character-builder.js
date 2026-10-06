import { requestJson } from "./api.js";
import { previewCharacterRequest } from "./character-preview.js";
import { setArtwork } from "./dom.js";
import { openArtwork } from "./artwork-viewer.js";
import { classText, t } from "./i18n.js";
import { openPortraitStudio } from "./portrait-studio.js";
import { standardScores, availableScores, assignScore } from "./score-assignment.js";

const abilities = ["str", "dex", "con", "int", "wis", "cha"];
let catalog = null;
let assignments = Object.fromEntries(abilities.map((ability) => [ability, null]));
let portraitDraft = { mode: "none", file: null };
let draftImageUrl = null;
let characters = [];
let currentCharacter = null;
let selectedCharacterId = null;
let selectedVersionId = null;
let editingCharacterId = null;
const previewParams = new URLSearchParams(window.location.search);
const characterRequest = previewParams.has("characters-preview") && previewParams.has("design-preview") ? previewCharacterRequest : requestJson;
const portraitUrl = (id) => characterRequest === previewCharacterRequest
  ? ({ "preview-mira": "/previews/mira.jpg", "preview-pip": "/previews/pip.jpg" })[id] ?? null
  : `/api/activity/characters/${encodeURIComponent(id)}/portrait`;
const portrait = (id, name, large = false) => {
  const frame = element("div", large ? "characters-portrait characters-portrait-large" : "characters-portrait");
  const picture = element("img");
  picture.hidden = true;
  const fallback = element("span", "characters-portrait-fallback", large ? t("activity.characters.noPortrait") : name.trim().slice(0, 1).toUpperCase());
  frame.append(picture, fallback);
  if (large) {
    const inspect = element("button", "characters-portrait-open artwork-open");
    inspect.type = "button";
    inspect.setAttribute("aria-label", t("activity.artwork.viewPartyPortrait", { name }));
    inspect.setAttribute("aria-haspopup", "dialog");
    inspect.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 5 5"></path></svg>';
    inspect.addEventListener("click", () => { void openArtwork(picture, name); });
    picture.addEventListener("click", () => { void openArtwork(picture, name); });
    frame.append(inspect);
  }
  void setArtwork(picture, fallback, portraitUrl(id), t("activity.hero.portraitAlt", { name }));
  return frame;
};

const dialog = () => document.querySelector("#character-builder-dialog");
const field = (id) => dialog().querySelector(`#${id}`);
const label = (id) => id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
const className = (id) => {
  const translated = t(`activity.creator.classOption.${id}`);
  return translated.startsWith("activity.") ? classText(id) : translated;
};
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};
const select = (id, values, textOf) => {
  const node = element("select");
  node.id = id;
  for (const value of values) {
    const option = element("option", "", textOf(value));
    option.value = value;
    node.append(option);
  }
  return node;
};
const labelled = (text, control) => {
  const node = element("label");
  node.append(element("span", "", text), control);
  return node;
};
const button = (text, click, primary = false) => {
  const node = element("button", `ui-control${primary ? " primary" : ""}`, text);
  node.type = "button";
  node.addEventListener("click", click);
  return node;
};
const feedback = (message) => { field("builder-feedback").textContent = message; };
const chosen = (name) => [...dialog().querySelectorAll(`input[name="${name}"]:checked`)].map((node) => node.value);
const raceText = (id) => {
  if (!id) return t("activity.characters.noAncestry");
  const translated = t(`activity.creator.race.${id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}`);
  return translated.startsWith("activity.") ? label(id) : translated;
};
const skillText = (id) => {
  const translated = t(`activity.creator.skill.${id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}`);
  return translated.startsWith("activity.") ? label(id) : translated;
};

export async function loadCharacters() {
  const payload = await characterRequest("/api/activity/characters");
  catalog = payload.catalog;
  characters = payload.characters;
  if (!dialog().childElementCount) wireCharacterCreator();
  document.dispatchEvent(new Event("activity-characters-loaded"));
  document.querySelector("#lobby-character-count").textContent = t("activity.characters.count", { count: characters.length });
  document.querySelector("#characters-rail-count").textContent = t("activity.characters.count", { count: characters.length });
  renderCharacterList();
  if (selectedCharacterId && characters.some((character) => character.id === selectedCharacterId)) await selectCharacter(selectedCharacterId, selectedVersionId);
  else if (characters.length) await selectCharacter(characters[0].id);
  else {
    selectedCharacterId = null;
    currentCharacter = null;
    const detail = document.querySelector("#characters-detail");
    detail.replaceChildren();
    const empty = element("div", "characters-detail-empty");
    empty.append(element("h2", "", t("activity.characters.emptyTitle")), element("p", "", t("activity.creator.emptyLibrary")), button(t("activity.characters.create"), () => openCharacterCreator(), true));
    detail.append(empty);
  }
}

const characterMessage = (text) => { document.querySelector("#characters-message").textContent = text; };

function renderCharacterList() {
  const list = document.querySelector("#characters-list");
  list.replaceChildren();
  if (!characters.length) list.append(element("p", "lobby-character-empty", t("activity.characters.emptyRail")));
  for (const character of characters) {
    const card = button("", () => void selectCharacter(character.id));
    card.classList.add("characters-list-item");
    const copy = element("span", "characters-list-copy");
    copy.append(element("strong", "", character.name), element("small", "", `${raceText(character.race)} · ${className(character.className)} · ${t("activity.characters.versions", { count: character.versionCount })}`));
    card.append(portrait(character.id, character.name), copy);
    card.setAttribute("aria-current", String(character.id === selectedCharacterId));
    list.append(card);
  }
}

export function openCharactersScreen() {
  document.querySelector("#lobby-screen").hidden = true;
  document.querySelector("#live-screen").hidden = true;
  document.querySelector("#characters-screen").hidden = false;
  if (!catalog) void loadCharacters().catch((error) => characterMessage(error.message));
}

export function wireCharacterScreen() {
  document.querySelector("#open-characters").addEventListener("click", openCharactersScreen);
  document.querySelector("#characters-back").addEventListener("click", () => {
    document.querySelector("#characters-screen").hidden = true;
    document.querySelector("#lobby-screen").hidden = false;
    characterMessage("");
  });
  document.querySelector("#characters-create").addEventListener("click", () => openCharacterCreator());
}

async function selectCharacter(characterId, versionId = null) {
  const detail = document.querySelector("#characters-detail");
  detail.textContent = t("activity.characters.loading");
  try {
    const payload = await characterRequest(`/api/activity/characters/${encodeURIComponent(characterId)}`);
    currentCharacter = payload.character;
    selectedCharacterId = characterId;
    selectedVersionId = versionId && currentCharacter.versions.some((version) => version.id === versionId) ? versionId : currentCharacter.versions.filter((version) => version.branch === "main").at(-1)?.id ?? currentCharacter.versions.at(-1)?.id ?? null;
    renderCharacterList();
    renderCharacterDetail();
  } catch (error) {
    detail.textContent = error instanceof Error ? error.message : t("activity.connection.requestFailed");
  }
}

function detailLine(title, value) {
  const row = element("div", "characters-detail-line");
  row.append(element("strong", "", title), element("span", "", value || "—"));
  return row;
}

function renderCharacterDetail(activeTab = "sheet") {
  const detail = document.querySelector("#characters-detail");
  detail.replaceChildren();
  if (!currentCharacter) return;
  const version = currentCharacter.versions.find((item) => item.id === selectedVersionId);
  if (!version) return;
  const build = version.build;
  const characterId = currentCharacter.id;
  const hero = element("div", "characters-detail-hero");
  hero.append(portrait(characterId, build.name, true));
  const title = element("div", "characters-detail-heading");
  title.append(element("h2", "", build.name), element("p", "", raceText(build.race) + " · " + className(build.class)));
  const actions = element("div", "characters-detail-actions");
  if (version.branch === "main") actions.append(button(t("activity.characters.edit"), () => openCharacterCreator(build, characterId), true));
  if (characterRequest !== previewCharacterRequest) actions.append(button(t("activity.portrait.manage"), () => void openPortraitStudio(characterId, build.name, () => { renderCharacterList(); renderCharacterDetail(activeTab); }).catch((error) => characterMessage(error.message))));
  title.append(actions);
  const history = element("details", "characters-history");
  history.append(element("summary", "", t("activity.characters.versionHistory")));
  const versionPicker = select("characters-version", [...currentCharacter.versions].reverse().map((item) => item.id), (id) => {
    const item = currentCharacter.versions.find((candidate) => candidate.id === id);
    const number = item.branch === "main" ? currentCharacter.versions.filter((candidate) => candidate.branch === "main" && candidate.revision <= item.revision).length : item.revision;
    return t("activity.characters.version", { number }) + (item.branch === "main" ? "" : " · " + t("activity.characters.gameVersion"));
  });
  versionPicker.value = version.id;
  versionPicker.addEventListener("change", () => { selectedVersionId = versionPicker.value; renderCharacterDetail(activeTab); });
  history.append(labelled(t("activity.characters.viewVersion"), versionPicker));
  title.append(history);
  hero.append(title);
  detail.append(hero);
  const tabs = element("nav", "hero-workspace-tabs characters-sheet-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", t("activity.characters.title"));
  for (const id of ["sheet", "equipment", "story"]) {
    const tab = button(t("activity.characters.tab." + id), () => renderCharacterDetail(id));
    tab.id = "characters-tab-" + id; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(activeTab === id)); tab.setAttribute("aria-controls", "characters-panel");
    tabs.append(tab);
  }
  tabs.addEventListener("keydown", (event) => {
    const index = ["sheet", "equipment", "story"].indexOf(activeTab);
    const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
    if (next === null) return;
    event.preventDefault(); const id = ["sheet", "equipment", "story"][next]; renderCharacterDetail(id); document.querySelector("#characters-tab-" + id).focus();
  });
  detail.append(tabs);
  const panel = element("section", "characters-sheet-panel"); panel.id = "characters-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", "characters-tab-" + activeTab);
  if (activeTab === "sheet") {
    const stats = element("div", "sheet-abilities characters-stats");
    for (const ability of abilities) {
      const score = (version.progression?.abilityScores ?? build.abilities)[ability];
      const modifier = Math.floor((score - 10) / 2);
      const tile = element("div", "sheet-ability");
      tile.append(element("span", "", ability.toUpperCase()), element("strong", "", (modifier >= 0 ? "+" : "") + modifier), element("small", "", String(score)));
      stats.append(tile);
    }
    panel.append(stats, detailLine(t("activity.creator.skills"), build.skills.map(skillText).join(", ")));
    if (build.expertise.length) panel.append(detailLine(t("activity.characters.expertise"), build.expertise.map(skillText).join(", ")));
    if (build.raceAbilityChoices?.length) panel.append(detailLine(t("activity.creator.halfElfAbilities"), build.raceAbilityChoices.map((item) => item.toUpperCase()).join(", ")));
    if (build.raceSkillChoices?.length) panel.append(detailLine(t("activity.creator.halfElfSkills"), build.raceSkillChoices.map(skillText).join(", ")));
    panel.append(detailLine(t("activity.characters.level"), String(version.progression ? Object.values(version.progression.classLevels).reduce((total, level) => total + level, 0) : 1)));
  } else if (activeTab === "equipment") {
    panel.append(detailLine(t("activity.creator.kit"), t("campaign.chars.kit." + build.kit)), detailLine(t("activity.characters.equipment"), version.gear.equipment.map((id) => label(id.replace(/^item:/, ""))).join(", ")));
  } else panel.append(detailLine(t("activity.creator.appearance"), build.appearance), detailLine(t("activity.creator.backstory"), build.backstory));
  detail.append(panel);
  const more = element("details", "characters-more"); more.append(element("summary", "", t("activity.characters.more")));
  more.append(button(t("activity.characters.delete"), () => showDeleteConfirmation()));
  detail.append(more);
}

function showDeleteConfirmation() {
  const detail = document.querySelector("#characters-detail");
  detail.querySelector(".characters-delete-confirm")?.remove();
  const confirm = element("div", "characters-delete-confirm");
  confirm.append(element("p", "", t("activity.characters.deleteConfirm", { name: currentCharacter.name })));
  const yes = button(t("activity.characters.deleteForever"), async () => {
    yes.disabled = true;
    try {
      await characterRequest(`/api/activity/characters/${encodeURIComponent(currentCharacter.id)}`, { method: "DELETE" });
      selectedCharacterId = null;
      selectedVersionId = null;
      currentCharacter = null;
      await loadCharacters();
      characterMessage(t("activity.characters.deleted"));
    } catch (error) { characterMessage(error instanceof Error ? error.message : t("activity.connection.requestFailed")); yes.disabled = false; }
  });
  yes.classList.add("danger");
  confirm.append(yes, button(t("activity.creator.cancel"), () => confirm.remove()));
  detail.append(confirm);
}

function buildChoices() {
  return {
    name: field("builder-name").value.trim(), race: field("builder-race").value, class: field("builder-class").value,
    appearance: field("builder-appearance").value.trim(), backstory: field("builder-backstory").value.trim(),
    kit: field("builder-kit").value,
    abilities: Object.fromEntries(abilities.map((ability) => [ability, assignments[ability] ?? 0])),
    skills: chosen("builder-skill"), expertise: chosen("builder-expertise"),
    ...(field("builder-race").value === "half-elf" ? { raceAbilityChoices: chosen("builder-race-ability"), raceSkillChoices: chosen("builder-race-skill") } : {}),
  };
}

function validate() {
  const build = buildChoices();
  const chosenClass = catalog.classes.find((entry) => entry.id === build.class);
  if (!build.name) return { message: t("activity.creator.nameRequired"), target: "builder-name" };
  if (new Set(Object.values(build.abilities)).size !== 6 || [...Object.values(build.abilities)].sort((a, b) => b - a).some((score, index) => score !== standardScores[index])) return { message: t("activity.creator.scoreError"), target: "builder-str" };
  if (build.skills.length !== chosenClass.skillCount) return { message: t("activity.creator.skillCount", { count: chosenClass.skillCount }), target: "builder-skills" };
  if (build.expertise.length !== chosenClass.expertiseCount || build.expertise.some((skill) => !build.skills.includes(skill))) return { message: t("activity.creator.expertiseCount", { count: chosenClass.expertiseCount }), target: "builder-expertise" };
  if (build.race === "half-elf" && (build.raceAbilityChoices.length !== 2 || build.raceSkillChoices.length !== 2 || build.raceSkillChoices.some((skill) => build.skills.includes(skill)))) return { message: t("activity.creator.halfElfError"), target: "builder-race-choices" };
  if (portraitDraft.mode === "upload" && !portraitDraft.file) return { message: t("activity.portrait.chooseReference"), target: "builder-portrait-file" };
  return null;
}

function renderScores() {
  const root = field("builder-scores");
  root.replaceChildren();
  for (const ability of abilities) {
    const tile = element("label", "sheet-ability builder-ability");
    const control = select("builder-" + ability, [], String);
    control.setAttribute("aria-label", ability.toUpperCase());
    const empty = element("option", "", t("activity.creator.assignScore"));
    empty.value = "";
    control.append(empty);
    for (const score of availableScores(assignments, ability)) {
      const option = element("option", "", String(score));
      option.value = String(score);
      control.append(option);
    }
    control.value = assignments[ability] === null ? "" : String(assignments[ability]);
    const modifier = assignments[ability] === null ? "—" : Math.floor((assignments[ability] - 10) / 2);
    tile.append(element("span", "", ability.toUpperCase()), element("strong", "", typeof modifier === "number" && modifier >= 0 ? "+" + modifier : String(modifier)), control);
    root.append(tile);
  }
  const remaining = standardScores.filter((score) => !Object.values(assignments).includes(score));
  field("builder-score-status").textContent = remaining.length ? t("activity.creator.remainingScores", { scores: remaining.join(" · ") }) : t("activity.creator.scoresAssigned");
}

function autoAssign() {
  assignments = { ...catalog.classes.find((entry) => entry.id === field("builder-class").value).suggestedAbilities };
  renderScores();
  feedback("");
}

function addChoices(root, name, choices, title, selected = []) {
  root.append(element("h3", "", title));
  for (const value of choices) {
    const input = element("input"); input.type = "checkbox"; input.name = name; input.value = value; input.checked = selected.includes(value);
    root.append(labelled(name === "builder-race-ability" ? value.toUpperCase() : skillText(value), input));
  }
}

function renderClassChoices(preserve = false) {
  if (!catalog) return;
  const selectedSkills = preserve ? chosen("builder-skill") : [];
  const selectedExpertise = preserve ? chosen("builder-expertise") : [];
  const oldKit = field("builder-kit").value;
  const chosenClass = catalog.classes.find((entry) => entry.id === field("builder-class").value);
  const skills = field("builder-skills"); skills.replaceChildren();
  addChoices(skills, "builder-skill", chosenClass.skillChoices, t("activity.creator.skillCount", { count: chosenClass.skillCount }), selectedSkills.filter((skill) => chosenClass.skillChoices.includes(skill)).slice(0, chosenClass.skillCount));
  const expertise = field("builder-expertise"); expertise.replaceChildren();
  if (chosenClass.expertiseCount) addChoices(expertise, "builder-expertise", chosenClass.skillChoices, t("activity.creator.expertiseCount", { count: chosenClass.expertiseCount }), selectedExpertise.filter((skill) => chosen("builder-skill").includes(skill)).slice(0, chosenClass.expertiseCount));
  field("builder-kit").replaceWith(select("builder-kit", chosenClass.kits, (kit) => {
    const translated = t("campaign.chars.kit." + kit);
    return translated.startsWith("campaign.") ? label(kit) : translated;
  }));
  if (preserve && chosenClass.kits.includes(oldKit)) field("builder-kit").value = oldKit;
  renderRaceChoices(preserve);
  renderScores();
  updateChoiceLimits();
}

function renderRaceChoices(preserve = false) {
  const selectedAbilities = preserve ? chosen("builder-race-ability") : [];
  const selectedSkills = preserve ? chosen("builder-race-skill") : [];
  const area = field("builder-race-choices");
  area.replaceChildren();
  if (field("builder-race").value !== "half-elf") return;
  addChoices(area, "builder-race-ability", abilities.filter((item) => item !== "cha"), t("activity.creator.halfElfAbilities"), selectedAbilities);
  addChoices(area, "builder-race-skill", catalog.skills, t("activity.creator.halfElfSkills"), selectedSkills);
}

function updateChoiceLimits() {
  const chosenClass = catalog.classes.find((entry) => entry.id === field("builder-class").value);
  const selectedSkills = chosen("builder-skill");
  for (const input of dialog().querySelectorAll('input[name="builder-expertise"]')) if (!selectedSkills.includes(input.value)) input.checked = false;
  for (const input of dialog().querySelectorAll('input[name="builder-race-skill"]')) if (selectedSkills.includes(input.value)) input.checked = false;
  const limits = { "builder-skill": chosenClass.skillCount, "builder-expertise": chosenClass.expertiseCount, "builder-race-ability": 2, "builder-race-skill": 2 };
  for (const [name, limit] of Object.entries(limits)) {
    const count = chosen(name).length;
    for (const input of dialog().querySelectorAll('input[name="' + name + '"]')) {
      input.disabled = !input.checked && (count >= limit || (name === "builder-expertise" && !selectedSkills.includes(input.value)) || (name === "builder-race-skill" && selectedSkills.includes(input.value)));
    }
  }
  field("builder-choice-status").textContent = t("activity.creator.skillsSelected", { count: selectedSkills.length, max: chosenClass.skillCount });
}

function updatePortraitDraft() {
  portraitDraft.mode = field("builder-portrait-mode").value;
  field("builder-save").textContent = t(portraitDraft.mode === "none" ? "activity.creator.save" : "activity.creator.saveContinue");
  field("builder-portrait-settings").hidden = portraitDraft.mode !== "upload";
  field("builder-portrait-upload").hidden = portraitDraft.mode !== "upload";
  const image = field("builder-portrait-image");
  const fallback = field("builder-portrait-fallback");
  image.hidden = !portraitDraft.file || portraitDraft.mode !== "upload";
  fallback.hidden = !image.hidden;
  if (image.hidden && editingCharacterId) void setArtwork(image, fallback, portraitUrl(editingCharacterId), t("activity.hero.portraitAlt", { name: field("builder-name").value }));
}

export function openCharacterCreator(existingBuild = null, characterId = null) {
  if (!catalog) { characterMessage(t("activity.creator.unavailable")); return; }
  editingCharacterId = characterId;
  const form = dialog();
  form.querySelectorAll("input[type=text], textarea").forEach((input) => { input.value = ""; });
  field("builder-name").value = existingBuild?.name ?? "";
  field("builder-appearance").value = existingBuild?.appearance ?? "";
  field("builder-backstory").value = existingBuild?.backstory ?? "";
  field("builder-race").value = existingBuild?.race ?? "human";
  field("builder-class").value = existingBuild?.class ?? "fighter";
  assignments = existingBuild ? { ...existingBuild.abilities } : Object.fromEntries(abilities.map((ability) => [ability, null]));
  renderClassChoices();
  if (existingBuild) {
    field("builder-kit").value = existingBuild.kit;
    for (const [name, values] of [["builder-skill", existingBuild.skills], ["builder-expertise", existingBuild.expertise], ["builder-race-ability", existingBuild.raceAbilityChoices ?? []], ["builder-race-skill", existingBuild.raceSkillChoices ?? []]]) {
      for (const input of form.querySelectorAll('input[name="' + name + '"]')) input.checked = values.includes(input.value);
    }
  }
  updateChoiceLimits();
  portraitDraft = { mode: "none", file: null };
  if (draftImageUrl) URL.revokeObjectURL(draftImageUrl);
  draftImageUrl = null;
  field("builder-portrait-file").value = "";
  field("builder-portrait-mode").value = "none";
  field("builder-portrait-style").value = "painterly";
  updatePortraitDraft();
  field("builder-save").textContent = t("activity.creator.save");
  field("builder-sheet-title").textContent = t(characterId ? "activity.creator.editSheet" : "activity.creator.title");
  feedback("");
  form.showModal();
  form.querySelector(".builder-sheet").scrollTop = 0;
}

export function wireCharacterCreator() {
  const form = dialog();
  form.classList.add("character-sheet-editor");
  form.replaceChildren();
  const header = element("header", "builder-header");
  const copy = element("div");
  const title = element("h2", "", t("activity.creator.title")); title.id = "builder-sheet-title";
  copy.append(title, element("p", "", t("activity.creator.sheetDescription")));
  const close = button("×", () => form.close()); close.setAttribute("aria-label", t("activity.creator.cancel"));
  header.append(copy, close);
  const sheet = element("div", "builder-sheet");
  const side = element("aside", "builder-sheet-side builder-panel");
  const frame = element("div", "portrait-studio-preview");
  const picture = element("img"); picture.id = "builder-portrait-image"; picture.hidden = true; picture.alt = t("activity.portrait.referencePreview");
  const fallback = element("span", "", t("activity.portrait.draftHelp")); fallback.id = "builder-portrait-fallback";
  frame.append(picture, fallback);
  const mode = select("builder-portrait-mode", ["none", "description", "upload"], (value) => t("activity.portrait.mode." + value));
  mode.setAttribute("aria-label", t("activity.portrait.section"));
  side.append(frame, element("h3", "", t("activity.portrait.section")), element("p", "builder-help", t("activity.portrait.nextStep")));
  mode.hidden = false;
  side.append(mode);
  const portraitSettings = element("div", "builder-panel"); portraitSettings.id = "builder-portrait-settings";
  const file = element("input"); file.type = "file"; file.accept = "image/png,image/jpeg,image/webp"; file.id = "builder-portrait-file";
  const upload = labelled(t("activity.portrait.upload"), file); upload.id = "builder-portrait-upload";
  const note = element("textarea"); note.id = "builder-portrait-note"; note.maxLength = 200; note.placeholder = t("activity.portrait.notePlaceholder");
  portraitSettings.append(upload, labelled(t("activity.portrait.styleLabel"), select("builder-portrait-style", ["painterly", "ink", "watercolor", "realistic"], (value) => t("activity.portrait.style." + value))), labelled(t("activity.portrait.noteLabel"), note), element("p", "builder-help", t("activity.portrait.afterSave")));
  for (const child of [...portraitSettings.children].slice(1)) child.hidden = true;
  const removePhoto = button(t("activity.portrait.clearReference"), () => {
    portraitDraft.file = null; field("builder-portrait-file").value = "";
    if (draftImageUrl) URL.revokeObjectURL(draftImageUrl);
    draftImageUrl = null; updatePortraitDraft();
  });
  portraitSettings.append(element("p", "builder-help", t("activity.portrait.uploadFirstHelp")), removePhoto);
  portraitSettings.hidden = true;
  side.append(portraitSettings);
  const main = element("div", "builder-sheet-main builder-panel");
  const identity = element("section", "builder-panel");
  const name = element("input"); name.id = "builder-name"; name.type = "text"; name.maxLength = 40; name.placeholder = t("activity.creator.namePlaceholder");
  identity.append(labelled(t("activity.creator.name"), name));
  const identityFields = element("div", "builder-fields");
  identityFields.append(labelled(t("activity.creator.ancestry"), select("builder-race", [], String)), labelled(t("activity.creator.class"), select("builder-class", [], String)));
  identity.append(identityFields);
  const stats = element("section", "builder-panel builder-sheet-section");
  const statsHeading = element("div", "builder-section-heading");
  statsHeading.append(element("h3", "", t("activity.creator.abilities")), button(t("activity.creator.autoAssign"), autoAssign));
  const scoreStatus = element("p", "builder-help"); scoreStatus.id = "builder-score-status"; scoreStatus.setAttribute("aria-live", "polite");
  const scores = element("div", "sheet-abilities builder-score-grid"); scores.id = "builder-scores";
  stats.append(statsHeading, element("p", "builder-help", t("activity.creator.eliminationHelp")), scores, scoreStatus);
  const skillsSection = element("section", "builder-panel builder-sheet-section");
  const skills = element("div", "builder-choice-grid"); skills.id = "builder-skills";
  const expertise = element("div", "builder-choice-grid"); expertise.id = "builder-expertise";
  const raceChoices = element("div", "builder-choice-grid"); raceChoices.id = "builder-race-choices";
  const choiceStatus = element("p", "builder-help"); choiceStatus.id = "builder-choice-status"; choiceStatus.setAttribute("aria-live", "polite");
  skillsSection.append(skills, choiceStatus, expertise, raceChoices);
  const gear = element("section", "builder-panel builder-sheet-section");
  gear.append(labelled(t("activity.creator.kit"), select("builder-kit", [], String)));
  const story = element("details", "builder-panel builder-sheet-section builder-story");
  story.append(element("summary", "", t("activity.creator.optionalStory")));
  const appearance = element("textarea"); appearance.id = "builder-appearance"; appearance.maxLength = 300; appearance.placeholder = t("activity.creator.appearancePlaceholder");
  const backstory = element("textarea"); backstory.id = "builder-backstory"; backstory.maxLength = 300; backstory.placeholder = t("activity.creator.backstoryPlaceholder");
  const storyFields = element("div", "builder-panel"); storyFields.append(labelled(t("activity.creator.appearance"), appearance), labelled(t("activity.creator.backstory"), backstory)); story.append(storyFields);
  main.append(identity, stats, skillsSection, gear, story);
  sheet.append(side, main);
  const footer = element("footer", "builder-sheet-footer");
  const message = element("p", "builder-feedback"); message.id = "builder-feedback"; message.setAttribute("role", "alert");
  const save = button(t("activity.creator.saveContinue"), async () => {
    const error = validate();
    if (error) {
      feedback(error.message);
      const target = field(error.target);
      const details = target.closest("details"); if (details) details.open = true;
      const focus = target.matches("input, select, textarea") ? target : target.querySelector("input:not(:disabled), select");
      focus?.focus();
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const build = buildChoices();
    const draft = { ...portraitDraft, style: field("builder-portrait-style").value, note: field("builder-portrait-note").value.trim() };
    save.disabled = true;
    feedback(t("activity.tables.saving"));
    try {
      const wasEditing = editingCharacterId !== null;
      const targetId = editingCharacterId;
      const result = await characterRequest(wasEditing ? "/api/activity/characters/" + encodeURIComponent(targetId) : "/api/activity/characters", { method: wasEditing ? "PUT" : "POST", body: JSON.stringify(build) });
      form.close();
      editingCharacterId = targetId ?? result.characterId;
      selectedCharacterId = targetId ?? result.characterId;
      selectedVersionId = null;
      await loadCharacters();
      characterMessage(t(wasEditing ? "activity.characters.updated" : "activity.creator.saved"));
      if (draft.mode !== "none") await openPortraitStudio(selectedCharacterId, build.name, () => { renderCharacterList(); renderCharacterDetail(); }, { ...draft, build, previewMode: characterRequest === previewCharacterRequest, onBack: () => { feedback(""); form.showModal(); } }).catch((failure) => characterMessage(failure.message));
    } catch (failure) { feedback(failure instanceof Error ? failure.message : t("activity.connection.requestFailed")); }
    finally { save.disabled = false; }
  }, true);
  save.id = "builder-save";
  footer.append(message, button(t("activity.creator.cancel"), () => form.close()), save);
  form.append(header, sheet, footer);
  form.addEventListener("change", (event) => {
    if (event.target.id === "builder-class") { renderClassChoices(true); feedback(t("activity.creator.classChanged")); }
    if (event.target.id === "builder-race") { renderRaceChoices(true); updateChoiceLimits(); }
    if (event.target.id.startsWith("builder-") && abilities.includes(event.target.id.slice(8))) {
      const ability = event.target.id.slice(8);
      assignments = assignScore(assignments, ability, event.target.value === "" ? null : Number(event.target.value));
      renderScores();
      field("builder-" + ability).focus();
    }
    if (event.target.name?.startsWith("builder-")) updateChoiceLimits();
    if (event.target.id === "builder-portrait-mode") updatePortraitDraft();
    if (event.target.id === "builder-portrait-file") {
      const file = event.target.files?.[0];
      if (file && (file.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
        feedback(t(file.size > 8 * 1024 * 1024 ? "activity.portrait.error.tooLarge" : "activity.portrait.error.badType"));
        event.target.value = ""; portraitDraft.file = null;
        if (draftImageUrl) URL.revokeObjectURL(draftImageUrl);
        draftImageUrl = null; updatePortraitDraft(); return;
      }
      portraitDraft.file = file ?? null;
      if (draftImageUrl) URL.revokeObjectURL(draftImageUrl);
      draftImageUrl = file ? URL.createObjectURL(file) : null;
      if (draftImageUrl) {
        field("builder-portrait-image").dataset.source = "";
        field("builder-portrait-image").src = draftImageUrl;
      }
      updatePortraitDraft();
    }
  });
  document.addEventListener("activity-characters-loaded", () => {
    if (!catalog) return;
    field("builder-race").replaceWith(select("builder-race", catalog.races, raceText));
    field("builder-class").replaceWith(select("builder-class", catalog.classes.map((entry) => entry.id), className));
  });
}
