<script setup>
import DefaultTheme from "vitepress/theme";
const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #home-hero-info-before>
      <p class="haf-eyebrow">
        <span class="haf-eyebrow-dot" aria-hidden="true"></span>BUILT FOR DISCORD GAMING COMMUNITIES
      </p>
    </template>
    <template #layout-bottom>
      <footer class="haf-footer">
        <div class="haf-footer-shell">
          <a class="haf-footer-brand" href="https://hafbot.xyz" aria-label="HAF Bot home">
            <img src="/logo.png" alt="" width="30" height="30" />
            <span>HAF BOT</span>
            <small>HELPFUL AS F**K</small>
          </a>
          <nav class="haf-footer-links" aria-label="Footer navigation">
            <a href="https://hafbot.xyz">Home</a>
            <a href="https://hafbot.xyz/changelog">What's New</a>
            <a href="https://hafbot.xyz/terms">Terms</a>
            <a href="https://hafbot.xyz/privacy">Privacy</a>
            <a href="https://hafbot.xyz/admin">Dashboard</a>
          </nav>
        </div>
      </footer>
    </template>
  </Layout>
</template>

<style>
/* Landing .site-footer treatment */
.haf-footer {
  border-top: 1px solid #202837;
  color: #727d90;
  background: #080b12d9;
}
.haf-footer-shell {
  width: min(1160px, calc(100% - 48px));
  min-height: 92px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-inline: auto;
  padding-block: 18px;
  font: 600 9px var(--haf-font-display);
  letter-spacing: 0.06em;
}
.haf-footer-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #c3cad8;
  text-decoration: none;
}
.haf-footer-brand img {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: contain;
}
.haf-footer-brand small {
  color: #5f6a80;
  font-size: 7px;
  letter-spacing: 0.14em;
}
.haf-footer-links a {
  margin-left: 24px;
  color: inherit;
  text-decoration: none;
  transition: color 0.15s;
}
.haf-footer-links a:hover {
  color: #dfe3ed;
}
@media (max-width: 700px) {
  .haf-footer-shell {
    min-height: 120px;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
  }
  .haf-footer-links a {
    margin: 0 18px 0 0;
  }
}
</style>
