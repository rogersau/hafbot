/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import { DiscordMessagePreview } from "../src/admin/components/discord-message-preview";
import { DiscordMessagePreviewImplementation } from "../src/admin/components/discord-message-preview-implementation";
import {
  loadDiscordMessagePreviewImplementation,
  preloadDiscordMessagePreviewImplementation,
} from "../src/admin/components/discord-message-preview-loader";

test("DiscordMessagePreview defers the Discord implementation behind activation", () => {
  const html = renderToString(
    <DiscordMessagePreview
      author="HAF Bot"
      embedTitle="Support Tickets"
      embedDescription="Open a **ticket** for *help*."
      embedColor="#57f287"
      embedFooter={{ text: "HAF Bot Support" }}
    />,
  );

  assert.match(html, /Load message preview/);
  assert.match(html, /h-\[18rem\]/);
  assert.doesNotMatch(html, /<discord-messages/);
});

test("DiscordMessagePreview shell stays independent of button payloads", () => {
  const html = renderToString(
    <DiscordMessagePreview
      author="HAF Bot"
      embedTitle="Tickets"
      buttons={[
        { label: "General", emoji: "🎫", variant: "primary" },
        { label: "Help", variant: "secondary" },
      ]}
    />,
  );

  assert.match(html, /Load message preview/);
  assert.doesNotMatch(html, /General|Help|discord-button/);
});

test("DiscordMessagePreview does not render markdown before activation", () => {
  const html = renderToString(
    <DiscordMessagePreview
      content="Hello **member**"
      embedFields={[{ name: "Role", value: "Assigned to <@&9876543210>" }]}
    />,
  );

  assert.doesNotMatch(html, /Hello|Assigned|@role/);
});

test("DiscordMessagePreview shell remains lightweight before activation", () => {
  const html = renderToString(<DiscordMessagePreview content="Choose a ticket type." />);

  assert.match(html, /Load message preview/);
  assert.doesNotMatch(html, /<discord-embed/);
});

test("activated Discord implementation renders embeds, markdown, and buttons", () => {
  const html = renderToString(
    <DiscordMessagePreviewImplementation
      content="Hello **member**"
      embedTitle="Support Tickets"
      embedDescription="Open a **ticket** for *help*."
      embedFooter={{ text: "HAF Bot Support" }}
      embedFields={[{ name: "Role", value: "Assigned to <@&9876543210>" }]}
      buttons={[{ label: "General", emoji: "🎫", variant: "primary" }]}
    />,
  );

  assert.match(html, /<discord-messages/);
  assert.match(html, /Hello <strong[^>]*>member<\/strong>/);
  assert.match(html, /<discord-embed-description[^>]*>.*Open a <strong/);
  assert.match(html, /<discord-embed-footer[^>]*>HAF Bot Support<\/discord-embed-footer>/);
  assert.match(html, /Assigned to .*@role/);
  assert.match(html, /<discord-button[^>]*>General<\/discord-button>/);
});

test("activated Discord implementation omits an embed for content-only messages", () => {
  const html = renderToString(
    <DiscordMessagePreviewImplementation content="Choose a ticket type." />,
  );

  assert.match(html, /Choose a ticket type\./);
  assert.doesNotMatch(html, /<discord-embed/);
});

test("Discord preview intent preload is cached for activation", async () => {
  const preload = preloadDiscordMessagePreviewImplementation();
  const activation = loadDiscordMessagePreviewImplementation();

  assert.equal(preload, activation);
  assert.equal(typeof (await activation), "function");
});
