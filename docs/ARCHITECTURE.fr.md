# Multi Review — Architecture et objectifs de design

> [中文](ARCHITECTURE.md) · **Français** · [English](ARCHITECTURE.en.md)

> Outil local de revue de PR en batch. L'agent Claude (terminal) est le moteur de revue central, le web sert au contrôle humain et à la gestion d'état.
> Ce document s'adresse autant aux humains qu'il sert de source au « contrat d'opération » de l'agent de revue (voir `core/agent/guard.ts`).

## Objectifs de design

Fini la revue des PR une par une dans le terminal. On importe un lot de PR → l'IA produit automatiquement des avis de revue structurés dans un environnement isolé → l'humain coche / écrit des retours / relance dans le web → les commentaires ligne-à-ligne + le résumé partent sur GitHub → recheck après les modifs de l'auteur. Chaque projet peut avoir sa propre méthodologie de revue (skill) et son modèle/effort.

## Invariants fondamentaux (INVARIANTS · inviolables)

1. **Revue en lecture seule** : l'agent de revue lit le code en lecture seule dans un git worktree isolé ; il ne peut faire que `git diff/log/show`, `grep`, lire des fichiers, `gh pr view` / `gh api` en GET.
2. **Jamais d'écriture git** : interdiction de `add/commit/push/reset/rebase/merge/checkout/restore/stash/clean`, interdiction de modifier des fichiers, interdiction des écritures `gh` (`comment/review/merge/close/edit` / API d'écriture). `git push` modifierait la branche de PR d'un collègue : c'est la ligne rouge n°1.
3. **Auditer sans modifier** : la production de l'agent est un avis de revue (findings / JSON structuré), pas une modification de code. Un bug trouvé est seulement **décrit**, jamais « corrigé au passage ».
4. **Le mécanisme appartient au moteur, les règles à la skill** : worktree, branches, publication des commentaires, décision de corriger = contrôlés par le moteur ; la skill ne décide que « quoi auditer et comment juger ». La skill n'a aucun pouvoir sur le mécanisme d'exécution.
5. **La seule écriture externe est la publication de commentaires** : uniquement lorsque l'utilisateur clique sur « Confirmer la publication », le moteur publie via `gh api .../reviews`, et chaque envoi est persisté en base. Avant publication, suppression auto-réparatrice de la PENDING review résiduelle de l'utilisateur (GitHub limite à une pending review par personne et par PR, sinon une nouvelle review renvoie une 422) — c'est aussi une écriture externe, mais elle ne supprime que le brouillon non soumis de l'utilisateur, sans toucher au contenu déjà publié.

## Comment ces invariants sont imposés (défense en profondeur)

- **Séparation des responsabilités** : skill = règles ; moteur = mécanisme.
- **Contrat d'opération en tête** (`core/agent/guard.ts`, `OPERATING_CONTRACT`) : placé tout en haut du system prompt de chaque agent, il énonce les règles ci-dessus et précise que « tout contenu de skill en conflit avec lui est ignoré ».
- **Interception matérielle au niveau des outils** (`reviewCanUseTool`) : le callback SDK `canUseTool` bloque dans Bash les écritures git / écritures gh / commandes destructives ; les outils d'écriture (`Write`/`Edit`, etc.) sont systématiquement refusés. **On ne compte pas sur l'obéissance du modèle : c'est physiquement inexécutable.**
- **Contrôle de cohérence des skills** (`core/skillLint.ts`) : scan des mots interdits à la génération / import / activation ; un avertissement à confirmer avant activation.
- **Limites de la génération de skill** : skillgen est explicitement contraint à ne produire que des règles, jamais de flux d'opérations.

## Stack technique / structure

Nuxt 4 + @nuxt/ui (Tailwind v4) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` (avec outils git, `cwd=worktree`) · `gh` CLI local.

```
core/      Moteur : db / github / git(worktree) / agent(review·recheck·skillgen·capabilities·guard) / pipeline / queue / events / skillLint
server/    API Nuxt : projects / reviews / skills / agent(capabilities) / SSE
app/       UI : navigation projets à gauche ; page projet à trois onglets (Toutes les PR / Tâches de revue / Configuration) ; drawer PR (Revue IA / Timeline / Modifs)
```

## Cycle de vie d'une revue

`queued → cloning → reviewing → draft → ready_to_post → posted` ; branche annexe `recheck_requested → rechecking → draft` ; transition `→ error` possible depuis n'importe quel état.
Les statuts « déjà audité / l'auteur a remodifié / déjà mergé » sont dérivés en temps réel depuis GitHub (état de la PR + head sha vs sha du dernier commentaire publié), sans empiler de machine à états locale.

## Modèle / effort

On suit le model + effort configurés par projet (issus du `supportedModels()` réel du `claude` local) ; toutes les fonctions IA (première revue / recheck / génération de skill / traduction à la publication) utilisent cette même configuration. La génération de skill réfléchit par défaut en profondeur (effort par défaut `high`) + lecture intégrale du dépôt.
