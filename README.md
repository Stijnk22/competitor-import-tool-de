# Competitor Import Tool

Zie `technisch-bouwplan.md` (los gedeeld in de chat) voor het volledige
architectuur- en fasenoverzicht.

## Status: t/m Fase 8 (multi-store beheer)

- Fase 1-7: scraper, 1-op-1 import, AI-content-optimalisatie (titel/
  beschrijving/meta), afbeeldingen (EXIF strippen/hernoemen/alt-tekst),
  volledige prijslogica, collectie- en category-matching, vertaling (5
  talen), batch-verwerking met live statusoverzicht
- Fase 8: **multi-store beheer** — stores worden nu beheerd via het
  dashboard zelf (niet meer via environment variables), met versleutelde
  opslag van access tokens in een PostgreSQL-database

## Nieuw vanaf Fase 8: een lokale database is nu nodig

In tegenstelling tot de vorige fases heb je vanaf nu een draaiende
PostgreSQL-database nodig, ook voor lokaal testen. Zie de exacte
installatie-instructies die in de chat zijn gegeven (Postgres.app voor Mac).

## Lokaal draaien

1. Zorg dat Node.js 20+ en PostgreSQL geïnstalleerd zijn (zie hierboven)
2. Installeer dependencies (dit genereert ook automatisch de Prisma-client):
   ```
   npm install
   ```
3. Kopieer `.env.example` naar `.env.local` en vul in:
   - `DATABASE_URL` — wijst naar je lokale Postgres-database
   - `ENCRYPTION_KEY` — genereer met `openssl rand -hex 32`
   - `ANTHROPIC_API_KEY`
4. Maak de database-tabellen aan:
   ```
   npx prisma migrate dev --name init
   ```
5. Start de development server:
   ```
   npm run dev
   ```
6. Open [http://localhost:3000](http://localhost:3000)
7. Voeg via het "Stores"-paneel bovenaan je eerste store toe (naam, Shopify-
   domein, Admin API access token)
8. Plak concurrent-URL's (één per regel) en start de import

## Naar GitHub pushen

```
git add .
git commit -m "Fase 8: multi-store beheer met versleutelde opslag"
git push
```

## Volgende stap

Railway-deployment (Postgres-service koppelen, environment variables
instellen, continuous deployment vanaf GitHub).
