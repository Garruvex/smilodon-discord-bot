import { requestJson } from "./api.js";
import { previewCharacterRequest } from "./character-preview.js";
import { setArtwork } from "./dom.js";
import { classText, t } from "./i18n.js";

const abilities = ["str", "dex", "con", "int", "wis", "cha"];
const standardScores = [15, 14, 13, 12, 10, 8];
let catalog = null;
let step = 0;
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

function renderCharacterDetail() {
  const detail = document.querySelector("#characters-detail");
  detail.replaceChildren();
  if (!currentCharacter) return;
  const version = currentCharacter.versions.find((item) => item.id === selectedVersionId);
  if (!version) return;
  const build = version.build;
  const hero = element("div", "characters-detail-hero");
  hero.append(portrait(currentCharacter.id, build.name, true));
  const title = element("div", "characters-detail-heading");
  title.append(element("h2", "", build.name), element("p", "", `${raceText(build.race)} · ${className(build.class)}`));
  hero.append(title);
  detail.append(hero);
  const versionPicker = select("characters-version", [...currentCharacter.versions].reverse().map((item) => item.id), (id) => {
    const item = currentCharacter.versions.find((candidate) => candidate.id === id);
    const number = item.branch === "main" ? currentCharacter.versions.filter((candidate) => candidate.branch === "main" && candidate.revision <= item.revision).length : item.revision;
    return `${t("activity.characters.version", { number })}${item.branch === "main" ? "" : ` · ${t("activity.characters.gameVersion")}`}`;
  });
  versionPicker.value = version.id;
  versionPicker.addEventListener("change", () => { selectedVersionId = versionPicker.value; renderCharacterDetail(); });
  title.append(labelled(t("activity.characters.viewVersion"), versionPicker));
  const stats = element("div", "characters-stats");
  for (const ability of abilities) stats.append(detailLine(ability.toUpperCase(), String((version.progression?.abilityScores ?? build.abilities)[ability])));
  detail.append(stats);
  const buildSection = element("section", "characters-sheet-section");
  buildSection.append(element("h3", "", t("activity.characters.buildSection")));
  const buildGrid = element("div", "characters-sheet-grid");
  buildGrid.append(detailLine(t("activity.creator.skills"), build.skills.map(skillText).join(", ")));
  if (build.expertise.length) buildGrid.append(detailLine(t("activity.characters.expertise"), build.expertise.map(skillText).join(", ")));
  if (build.raceAbilityChoices?.length) buildGrid.append(detailLine(t("activity.creator.halfElfAbilities"), build.raceAbilityChoices.map((item) => item.toUpperCase()).join(", ")));
  if (build.raceSkillChoices?.length) buildGrid.append(detailLine(t("activity.creator.halfElfSkills"), build.raceSkillChoices.map(skillText).join(", ")));
  buildGrid.append(detailLine(t("activity.creator.kit"), t(`campaign.chars.kit.${build.kit}`)));
  buildGrid.append(detailLine(t("activity.characters.equipment"), version.gear.equipment.map((id) => label(id.replace(/^item:/, ""))).join(", ")));
  if (version.progression) buildGrid.append(detailLine(t("activity.characters.level"), String(Object.values(version.progression.classLevels).reduce((total, level) => total + level, 0))));
  buildSection.append(buildGrid);
  detail.append(buildSection);
  const storySection = element("section", "characters-sheet-section");
  storySection.append(element("h3", "", t("activity.characters.storySection")), detailLine(t("activity.creator.appearance"), build.appearance), detailLine(t("activity.creator.backstory"), build.backstory));
  detail.append(storySection);
  const actions = element("div", "characters-detail-actions");
  if (version.branch === "main") actions.append(button(t("activity.characters.edit"), () => openCharacterCreator(build, currentCharacter.id), true));
  actions.append(button(t("activity.characters.delete"), () => showDeleteConfirmation()));
  detail.append(actions);
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
    abilities: Object.fromEntries(abilities.map((ability) => [ability, Number(field(`builder-${ability}`).value)])),
    skills: chosen("builder-skill"), expertise: chosen("builder-expertise"),
    ...(field("builder-race").value === "half-elf" ? { raceAbilityChoices: chosen("builder-race-ability"), raceSkillChoices: chosen("builder-race-skill") } : {}),
  };
}

function validate(stage) {
  const build = buildChoices();
  const chosenClass = catalog.classes.find((entry) => entry.id === build.class);
  if (stage >= 0 && !build.name) return t("activity.creator.nameRequired");
  if (stage >= 1) {
    if (new Set(Object.values(build.abilities)).size !== 6 || [...Object.values(build.abilities)].sort((a, b) => b - a).some((score, index) => score !== standardScores[index])) return t("activity.creator.scoreError");
    if (build.skills.length !== chosenClass.skillCount) return t("activity.creator.skillCount", { count: chosenClass.skillCount });
    if (build.expertise.length !== chosenClass.expertiseCount || build.expertise.some((skill) => !build.skills.includes(skill))) return t("activity.creator.expertiseCount", { count: chosenClass.expertiseCount });
    if (build.race === "half-elf" && (build.raceAbilityChoices.length !== 2 || build.raceSkillChoices.length !== 2 || build.raceSkillChoices.some((skill) => build.skills.includes(skill)))) return t("activity.creator.halfElfError");
  }
  return null;
}

function renderClassChoices() {
  if (!catalog) return;
  const chosenClass = catalog.classes.find((entry) => entry.id === field("builder-class").value);
  const scores = field("builder-scores");
  scores.replaceChildren();
  for (const ability of abilities) scores.append(labelled(ability.toUpperCase(), select(`builder-${ability}`, standardScores, String)));
  for (const ability of abilities) field(`builder-${ability}`).value = String(chosenClass.suggestedAbilities[ability]);
  const skills = field("builder-skills");
  skills.replaceChildren(element("h3", "", t("activity.creator.skillCount", { count: chosenClass.skillCount })));
  for (const skill of chosenClass.skillChoices) {
    const input = element("input"); input.type = "checkbox"; input.name = "builder-skill"; input.value = skill;
    skills.append(labelled(skillText(skill), input));
  }
  const expertise = field("builder-expertise");
  expertise.replaceChildren();
  if (chosenClass.expertiseCount) {
    expertise.append(element("h3", "", t("activity.creator.expertiseCount", { count: chosenClass.expertiseCount })));
    for (const skill of chosenClass.skillChoices) {
      const input = element("input"); input.type = "checkbox"; input.name = "builder-expertise"; input.value = skill;
      expertise.append(labelled(skillText(skill), input));
    }
  }
  field("builder-kit").replaceWith(select("builder-kit", chosenClass.kits, (kit) => {
    const translated = t(`campaign.chars.kit.${kit}`);
    return translated.startsWith("campaign.") ? label(kit) : translated;
  }));
  renderRaceChoices();
}

function renderRaceChoices() {
  const area = field("builder-race-choices");
  area.replaceChildren();
  if (field("builder-race").value !== "half-elf") return;
  area.append(element("h3", "", t("activity.creator.halfElfAbilities")));
  for (const ability of abilities.filter((item) => item !== "cha")) {
    const input = element("input"); input.type = "checkbox"; input.name = "builder-race-ability"; input.value = ability;
    area.append(labelled(ability.toUpperCase(), input));
  }
  area.append(element("h3", "", t("activity.creator.halfElfSkills")));
  for (const skill of catalog.skills) {
    const input = element("input"); input.type = "checkbox"; input.name = "builder-race-skill"; input.value = skill;
    area.append(labelled(skillText(skill), input));
  }
}

function showStep(next) {
  if (next > step) {
    const error = validate(step);
    if (error) { feedback(error); return; }
  }
  feedback("");
  step = next;
  for (const [index, panel] of [...dialog().querySelectorAll("[data-builder-panel]")].entries()) panel.hidden = index !== step;
  for (const [index, tab] of [...dialog().querySelectorAll("[data-builder-step]")].entries()) tab.setAttribute("aria-current", String(index === step));
  if (step === 2) {
    const build = buildChoices();
    field("builder-review-name").textContent = build.name;
    field("builder-review-subtitle").textContent = `${raceText(build.race)} ${className(build.class)} · ${t("activity.lobby.levelOne")}`;
    field("builder-review-details").textContent = `${t("activity.creator.skills")}: ${build.skills.map(skillText).join(", ")} · ${t("activity.creator.kit")}: ${t(`campaign.chars.kit.${build.kit}`)}`;
    field("builder-review-stats").replaceChildren(...abilities.map((ability) => element("span", "", `${ability.toUpperCase()} ${build.abilities[ability]}`)));
  }
}

export function openCharacterCreator(existingBuild = null, characterId = null) {
  if (!catalog) { characterMessage(t("activity.creator.unavailable")); return; }
  editingCharacterId = characterId;
  const saveButton = field("builder-save");
  saveButton.textContent = t(characterId ? "activity.characters.saveVersion" : "activity.creator.save");
  const form = dialog();
  form.querySelectorAll("input[type=text], textarea").forEach((input) => { input.value = ""; });
  field("builder-race").value = "human";
  field("builder-class").value = "fighter";
  renderClassChoices();
  if (existingBuild) {
    field("builder-name").value = existingBuild.name;
    field("builder-appearance").value = existingBuild.appearance;
    field("builder-backstory").value = existingBuild.backstory;
    field("builder-race").value = existingBuild.race ?? "human";
    field("builder-class").value = existingBuild.class;
    renderClassChoices();
    field("builder-kit").value = existingBuild.kit;
    for (const ability of abilities) field(`builder-${ability}`).value = String(existingBuild.abilities[ability]);
    for (const [name, values] of [["builder-skill", existingBuild.skills], ["builder-expertise", existingBuild.expertise], ["builder-race-ability", existingBuild.raceAbilityChoices ?? []], ["builder-race-skill", existingBuild.raceSkillChoices ?? []]]) {
      for (const input of form.querySelectorAll(`input[name="${name}"]`)) input.checked = values.includes(input.value);
    }
  }
  step = 0;
  showStep(0);
  form.showModal();
}

export function wireCharacterCreator() {
  const form = dialog();
  form.replaceChildren();
  const header = element("header", "builder-header");
  const copy = element("div");
  copy.append(element("h2", "", t("activity.creator.title")), element("p", "", t("activity.creator.description")));
  header.append(copy, button("×", () => form.close()));
  const tabs = element("nav", "builder-steps");
  ["identity", "build", "review"].forEach((name, index) => {
    const tab = button(`${index + 1}  ${t(`activity.creator.${name}`)}`, () => showStep(index));
    tab.dataset.builderStep = name;
    tabs.append(tab);
  });
  const identity = element("section", "builder-panel"); identity.dataset.builderPanel = "identity";
  const name = element("input"); name.id = "builder-name"; name.type = "text"; name.maxLength = 40;
  identity.append(labelled(t("activity.creator.name"), name));
  const identityFields = element("div", "builder-fields");
  identityFields.append(labelled(t("activity.creator.ancestry"), select("builder-race", [], String)), labelled(t("activity.creator.class"), select("builder-class", [], String)));
  identity.append(identityFields);
  const appearance = element("textarea"); appearance.id = "builder-appearance"; appearance.maxLength = 300;
  const backstory = element("textarea"); backstory.id = "builder-backstory"; backstory.maxLength = 300;
  identity.append(labelled(t("activity.creator.appearance"), appearance), labelled(t("activity.creator.backstory"), backstory), button(t("activity.creator.continue"), () => showStep(1), true));
  const build = element("section", "builder-panel"); build.dataset.builderPanel = "build";
  build.append(element("h3", "", t("activity.creator.abilities")), element("p", "", t("activity.creator.scoreHelp")));
  const scores = element("div", "builder-score-grid"); scores.id = "builder-scores"; build.append(scores);
  const skills = element("div", "builder-choice-grid"); skills.id = "builder-skills"; build.append(skills);
  const expertise = element("div", "builder-choice-grid"); expertise.id = "builder-expertise"; build.append(expertise);
  const raceChoices = element("div", "builder-choice-grid"); raceChoices.id = "builder-race-choices"; build.append(raceChoices);
  build.append(labelled(t("activity.creator.kit"), select("builder-kit", [], String)));
  const buildButtons = element("div", "builder-buttons"); buildButtons.append(button(t("activity.creator.back"), () => showStep(0)), button(t("activity.creator.continue"), () => showStep(2), true)); build.append(buildButtons);
  const review = element("section", "builder-panel"); review.dataset.builderPanel = "review";
  const reviewName = element("h3"); reviewName.id = "builder-review-name";
  const subtitle = element("p"); subtitle.id = "builder-review-subtitle";
  const details = element("p"); details.id = "builder-review-details";
  const stats = element("div", "builder-review-stats"); stats.id = "builder-review-stats";
  const reviewButtons = element("div", "builder-buttons");
  const save = button(t("activity.creator.save"), async () => {
    const error = validate(1);
    if (error) { feedback(error); return; }
    save.disabled = true;
    try {
      const wasEditing = editingCharacterId !== null;
      const targetId = editingCharacterId;
      const result = await characterRequest(wasEditing ? `/api/activity/characters/${encodeURIComponent(targetId)}` : "/api/activity/characters", { method: wasEditing ? "PUT" : "POST", body: JSON.stringify(buildChoices()) });
      form.close();
      editingCharacterId = null;
      selectedCharacterId = targetId ?? result.characterId;
      selectedVersionId = null;
      await loadCharacters();
      characterMessage(t(wasEditing ? "activity.characters.updated" : "activity.creator.saved"));
    } catch (failure) { feedback(failure instanceof Error ? failure.message : t("activity.connection.requestFailed")); }
    finally { save.disabled = false; }
  }, true);
  save.id = "builder-save";
  reviewButtons.append(button(t("activity.creator.back"), () => showStep(1)), save);
  review.append(reviewName, subtitle, stats, details, reviewButtons);
  const message = element("p", "builder-feedback"); message.id = "builder-feedback"; message.setAttribute("role", "alert");
  form.append(header, tabs, identity, build, review, message);
  form.addEventListener("change", (event) => {
    if (event.target.id === "builder-class") renderClassChoices();
    if (event.target.id === "builder-race") renderRaceChoices();
  });
  // The authenticated lobby load fills these pickers; the dialog is never opened before then.
  const populate = () => {
    if (!catalog) return;
    field("builder-race").replaceWith(select("builder-race", catalog.races, raceText));
    field("builder-class").replaceWith(select("builder-class", catalog.classes.map((entry) => entry.id), className));
  };
  document.addEventListener("activity-characters-loaded", populate);
}
