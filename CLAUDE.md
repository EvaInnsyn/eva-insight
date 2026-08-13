# Eva Insight — proxy + Chrome-viðbót

## ⚠️ Lestu handoff-möppuna fyrst

Heildarmyndin af kerfunum tveimur er **ekki** í þessu repo-i. Hún er í hinu:

**`/Users/disa/eva-innsyn/docs/handoff/`**

Byrjaðu þar í hverri lotu, áður en þú svarar spurningu um hvernig kerfið virkar
eða skrifar línu af kóða — sérstaklega `01-arkitektur.md` (hvert AI-köllin fara)
og `02-gildrur.md`. Skráðu hverja breytingu strax í `04-breytingaskra.md`, líka
þær sem þú gerir hérna megin.

**Staðfestu áður en þú fullyrðir.** Eitt `grep` er ekki staðfesting — lestu
kallið á enda. Ef þú veist ekki, segðu að þú vitir ekki.

---

## Hvað þetta repo er

Hono-þjónn á Railway sem gerir tvennt: er **AI-proxy** fyrir bæði
Chrome-viðbótina og Eva-spjallið í mælaborðinu, og heldur utan um **inneign
viðbótarinnar** í SQLite á Railway-diski.

Deployast sjálfkrafa við push á `main`.

- `server/src/routes/chat.ts` — `/v1/chat`. Mælir (`recordUsage`) og gjaldfærir
  (`chargeCredit`) hvert einasta kall, með 2× álagi. **Spjallið í mælaborðinu
  fer hér í gegn, ekki beint á Anthropic.**
- `server/src/db.ts` — `credit_lots`, `usage_events`, `credit_events`,
  brennsluröð og fyrning.
- `server/src/routes/admin.ts` — gamla adminið, varið með
  `EVA_INSIGHT_ADMIN_PASSWORD`. Eina virka leiðin til að gefa prufu-inneign.
- `server/src/supabase.ts` — hálfbyggð brú í platforminn (`resolveTenantId`,
  `insertEvents`).
- `extension/` — Chrome-viðbótin sjálf.

## Vinnulag

Íslenska í viðmóti og commit-skeytum. Fleiri Claude-lotur vinna oft í þessu tré
samtímis — keyrðu `git status` og stagea bara þínar eigin skrár, aldrei
`git add -A`.
