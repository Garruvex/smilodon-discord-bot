import { describe, expect, it, vi } from "vitest";

import { languages } from "../../src/application/i18n/language.js";
import { controlIds } from "../../src/infrastructure/discord/settings/panel/control-ids.js";
import { maxComponents } from "../../src/infrastructure/discord/settings/panel/panel-messages.js";
import { SetupGuide } from "../../src/infrastructure/discord/settings/setup/setup-guide.js";
import { actorUserId, engineFixture, guildId, slashValues, type EngineFixture } from "../helpers/settings-fixtures.js";

interface ComponentJson {
  type: number;
  custom_id?: string;
  label?: string;
  content?: string;
  components?: ComponentJson[];
  accessory?: ComponentJson;
}

type Mock = ReturnType<typeof vi.fn>;

interface FakeInteraction {
  interaction: never;
  update: Mock;
  editReply: Mock;
  followUp: Mock;
}

// A button press on the guide's message, as far as the guide looks at one.
function press(customId: string): FakeInteraction {
  const update = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const followUp = vi.fn(() => Promise.resolve());
  const interaction = {
    customId,
    guildId,
    guild: null,
    user: { id: actorUserId },
    inCachedGuild: (): boolean => true,
    isAnySelectMenu: (): boolean => false,
    update,
    editReply,
    followUp,
    deferUpdate: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
  return { interaction: interaction as never, update, editReply, followUp };
}

function flatten(component: ComponentJson): ComponentJson[] {
  const children = [...(component.components ?? []), ...(component.accessory ? [component.accessory] : [])];
  return [component, ...children.flatMap(flatten)];
}

// Every component in what a mock was last called with.
function components(mock: Mock): ComponentJson[] {
  const [payload] = mock.mock.calls.at(-1) as [{ components: { toJSON(): ComponentJson }[] }];
  return payload.components.flatMap((component) => flatten(component.toJSON()));
}

const labels = (mock: Mock): string[] => components(mock).flatMap((component) => (component.label ? [component.label] : []));

function guide(fixture: EngineFixture = engineFixture()): SetupGuide {
  return new SetupGuide(fixture.engine, fixture.profiles, { warn: vi.fn() } as never);
}

describe("SetupGuide", () => {
  it("starts with the panel channel and the language, then the settings marked for setup", () => {
    const paths = guide().steps().map((step) => step.path);

    expect(paths.slice(0, 2)).toEqual(["access.admin-panel", "community.language"]);
    expect(paths).toContain("access.roles");
    expect(paths).toContain("chat.replies.mention-chat");
    expect(paths).not.toContain("chat.persona.persona-drift");
    expect(new Set(paths).size).toBe(paths.length);
  });

  for (const language of languages) {
    it(`renders every step within Discord's limits in ${language}, with ids the guide can route`, async () => {
      const fixture = engineFixture();
      await fixture.run("community.language", slashValues({ language }));
      const subject = guide(fixture);
      const total = subject.steps().length;

      for (let step = 0; step <= total; step += 1) {
        const { interaction, update } = press(`wiz:0:go:${step}`);
        await subject.handleComponent(interaction);
        const rendered = components(update);

        expect(rendered.length, `step ${step}`).toBeLessThanOrEqual(maxComponents);
        for (const { custom_id: id } of rendered) {
          if (!id) continue;
          expect(id.length).toBeLessThanOrEqual(100);
          const [, stepText, code] = id.split(":");
          expect(Number(stepText)).toBe(step);
          const guideButton = ["go", "later", "finish", "create"].includes(code!);
          expect(guideButton || controlIds(`wiz:${step}`).parse(id) !== null, id).toBe(true);
        }
      }
    });
  }

  it("saves a change through the engine, as guided setup, and then offers Next instead of Skip", async () => {
    const fixture = engineFixture();
    const subject = guide(fixture);
    const step = subject.steps().findIndex((registered) => registered.path === "music.dj-mode");

    const shown = press(`wiz:0:go:${step}`);
    await subject.handleComponent(shown.interaction);
    expect(labels(shown.update)).toContain("Skip");

    const toggled = press(controlIds(`wiz:${step}`).encode({ kind: "toggle", path: "music.dj-mode", option: "enabled", value: true }));
    await subject.handleComponent(toggled.interaction);

    expect(fixture.profiles.current().music.djModeEnabled).toBe(true);
    expect(labels(toggled.editReply)).toContain("Next");
  });

  it("remembers where the guild left off", async () => {
    const subject = guide();
    await subject.handleComponent(press("wiz:0:go:3").interaction);
    const later = press("wiz:3:later");
    await subject.handleComponent(later.interaction);

    const reply = vi.fn(() => Promise.resolve());
    await subject.start({ guildId, reply } as never);

    const heading = components(reply).find((component) => component.content?.startsWith("-# Step"))?.content;
    expect(heading).toContain("Step 4 of");
  });

  it("finishes on a summary that points at the admin panel", async () => {
    const fixture = engineFixture();
    await fixture.run("access.admin-panel", slashValues({ channel: { id: "710000000000000001" } }));
    const subject = guide(fixture);

    const last = press(`wiz:0:go:${subject.steps().length}`);
    await subject.handleComponent(last.interaction);

    expect(components(last.update).some((component) => component.content?.includes("<#710000000000000001>"))).toBe(true);
    expect(labels(last.update)).toEqual(["Back", "Finish"]);
  });
});
