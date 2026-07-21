# Admin Command Center, upphafspunktur

*Skrifað 21. júlí 2026 sem handoff í nýja Claude Code session. Verkefnið:
endursmíða admin dashboardið sem öflugt command center fyrir Vigdísi.*

## Núverandi admin (það sem verið er að leysa af hólmi)

- **Slóð:** https://eva-insightserver-production.up.railway.app/admin
- **Auth:** eitt lykilorð, `EVA_INSIGHT_ADMIN_PASSWORD` (Railway env, sama gildi í `server/.env`), cookie-session eftir login
- **Tækni:** server-renderað HTML beint úr streng í `server/src/routes/admin.ts` (Hono, ~450 línur), ekkert framework, engin build-skref, inline CSS
- **Hýsing:** sami Railway-þjónn og AI-proxyinn (deployast við push á main í þessu repo)

### Hvað hann kann í dag
- Notendatafla: nafn, staða (Active/Revoked), pakkahnappar (+INNSÝN 5.000 / +YFIRSÝN 15.000 / +UMSJÁ 35.000, leggjast saman), **Inneign** (staða í kr, síðustu 3 hreyfingar, handvirkt +/− form með ástæðureit), virkni (síðast virkur, lotur/viku, meðallengd, % gegnum platform), token-súlur, áætlaður API-kostnaður/mán, Revoke, Caps-form (gamla kerfið)
- Yfirlitskort: áætlaður API-kostnaður mánaðar (verðlagt per módel), keypt inneign í mánuðinum, útistandandi inneign, tokens
- Búa til notanda (gamla tok_-leiðin)

### Gögnin sem eru til (SQLite á Railway Volume, `server/src/db.ts`)
- `users`: id, name, token, supabase_user_id, plan, credit_balance_isk (NULL = gamla mánaðarþaks-kerfið), caps/counters, revoked_at
- `usage_events`: per-request notkun m/ model, source (extension/platform), ts — 90 daga
- `credit_events`: allar inneignarhreyfingar m/ delta, balance_after, reason, ts
- `user_memories`: langtímaminni Evu per notanda
- Hjálparföll tilbúin: `monthUsageByModel()`, `getUserActivity()` (30-mín sessionization), `listCreditEvents()`, `grantCredit()/chargeCredit()`, `setUserPlan()`; verðlagning í `server/src/pricing.ts` (MODEL_PRICES + EVA_USD_ISK/EVA_CREDIT_MARKUP env-hnappar)

### Tengd kerfi sem command center gæti talað við
- **Supabase platformurinn** (project joqeipjawrlnscdvsgna): organisations, users, projects/möppur, sessions/Lotur, project_files, brand_profiles — service-lykill í `/Users/disa/eva-innsyn/.env.local` (ALDREI í git)
- **Railway proxy API:** /healthz, /v1/plan (S2S m/ shared secret), /v1/memory
- **Vercel MCP** (deploy-staða, runtime logs) er tengt í Claude Code

## Hönnunarmál (læst)
Pappír `#FFFDFA` · hvít spjöld · rautt blek `#BE3519` (rammar, hnappar, fyrirsagnir) · svart letur `#16130F` · hlýr tónn `#F6F2EB` · grænn `#1A7A4A` aðeins sem stöðulitur. ENGINN bleikur, ENGINN fjólublár. Engin löng strik í texta, kommur (stutt bandstrik - er í lagi). League Spartan (fyrirsagnir, uppercase) + Poppins. „Done by Eva Innsýn" stimpillinn er merkið.

## Opnar spurningar fyrir plönunina
- Hvar á hann að búa: áfram á Railway-þjóninum (einfalt, nær gögnunum) eða inni í Next-platforminum (React, betri UI-verkfæri, en þarf S2S-brú í SQLite-gögnin)?
- Hvað gerir hann að „command center": rauntímayfirlit? aðgerðir (inneign, notendur, endurgreiðslur)? viðvaranir (lág inneign, villur, kostnaður)? tekju-/notkunargröf? Eva-aðstoð inni í honum?
- Á gamli admin að lifa þar til sá nýi er fullbúinn (já, öruggast)?

## Vinnulag Vigdísar (mikilvægt)
Plana fyrst saman (kort → demo → samþykki → byggja), sýna hverja breytingu live, ein breyting í einu. Sjá memory: feedback-plana-saman.
