# Identity Audit (read-only, 2026-06-27)

LDAP users: 45 · with local shadow: 12 · locker-owner mismatch: 8 · missing locker: 16 · clean: 16

| user | LDAP uid | local /etc/passwd uid (node1) | locker owner | mode | status |
|---|---|---|---|---|---|
| abdifetaho | 10024 | 1012 | 10024 | 2777 | SHADOWED |
| amphunc | 10015 | - | 10015 | 2777 | OK |
| athitak | 10038 | - | none | - | NO-LOCKER |
| boonyisak | 10047 | - | none | - | NO-LOCKER |
| chanetteej | 10014 | 1006 | 10014 | 2777 | SHADOWED |
| dianap | 10012 | 1005 | 1005 | 2777 | SHADOWED,LOCKER-MISMATCH |
| duangpornk | 10045 | - | none | - | NO-LOCKER |
| ekalakm | 10052 | - | none | - | NO-LOCKER |
| haymaro | 10007 | - | 10007 | 2777 | OK |
| hpcteama | 10021 | 1010 | 1000 | 2777 | SHADOWED,LOCKER-MISMATCH |
| jantappapac | 10003 | - | 10003 | 2777 | OK |
| juthamass | 10029 | - | none | - | NO-LOCKER |
| khinsusuh | 10040 | 1018 | 10040 | 2777 | SHADOWED |
| kriengkraip | 10000 | - | 10000 | 2777 | OK |
| krittiyabhornk | 10002 | - | 10002 | 2777 | OK |
| monthiras | 10027 | 1014 | 1014 | 2777 | SHADOWED,LOCKER-MISMATCH |
| natcharees | 10046 | - | none | - | NO-LOCKER |
| nuttidam | 10030 | - | 10030 | 2777 | OK |
| pasithp | 10019 | 1009 | 10019 | 2777 | SHADOWED |
| paweenap | 10049 | - | none | - | NO-LOCKER |
| pisarnsrik | 10051 | - | none | - | NO-LOCKER |
| piyachartt | 10053 | - | none | - | NO-LOCKER |
| porncheerac | 10001 | - | 10001 | 2777 | OK |
| punna | 10020 | - | 10020 | 2777 | OK |
| punyapornn | 10036 | 1013 | 1013 | 2777 | SHADOWED,LOCKER-MISMATCH |
| romgases | 10006 | - | 10006 | 2777 | OK |
| ryanr | 10037 | 1015 | 10037 | 2700 | SHADOWED |
| samaw | 10042 | - | none | - | NO-LOCKER |
| saners | 10043 | - | none | - | NO-LOCKER |
| sanongp | 10044 | - | none | - | NO-LOCKER |
| sarochas | 10033 | - | 10033 | 2777 | OK |
| sarunt | 10004 | 1007 | 1007 | 2777 | SHADOWED,LOCKER-MISMATCH |
| siwakornp | 10034 | - | 10034 | 2777 | OK |
| somponnats | 10010 | - | 10010 | 2777 | OK |
| sotidak | 10039 | - | none | - | NO-LOCKER |
| supawanj | 10026 | 1017 | 1017 | 2777 | SHADOWED,LOCKER-MISMATCH |
| sutthipuns | 10018 | - | 10018 | 2777 | OK |
| tenxr | 10035 | - | 1000 | 2777 | LOCKER-MISMATCH |
| thanaphonl | 10032 | 1011 | 1011 | 2777 | SHADOWED,LOCKER-MISMATCH |
| thararatl | 10050 | - | none | - | NO-LOCKER |
| thitaphab | 10048 | - | none | - | NO-LOCKER |
| thunyarats | 10022 | - | 10022 | 2777 | OK |
| tonpees | 10054 | - | none | - | NO-LOCKER |
| toobaj | 10008 | - | 10008 | 2777 | OK |
| trinj | 10031 | - | 10031 | 2777 | OK |

## Orphan locker dirs (not LDAP users) — 24
- Alignment-work (owner uid 1000, mode 2777)
- DATA_PSOM (owner uid 1000, mode 2777)
- MMC HaCaT[6967] (owner uid 1000, mode 2777)
- Milk CCA (owner uid 1000, mode 2777)
- Organoids CRC (owner uid 1000, mode 2777)
- Primary (owner uid 1000, mode 2777)
- VIGOR_DB (owner uid 1000, mode 2777)
- apphub (owner uid 0, mode 2775)
- gannasut-test (owner uid 1000, mode 2777)
- gdc (owner uid 1000, mode 2777)
- gigadb_100439 (owner uid 1000, mode 2777)
- leantime (owner uid 1000, mode 2777)
- mcmicro_workshop (owner uid 1000, mode 2777)
- ngi-igenomes (owner uid 1000, mode 2777)
- patipark (owner uid 1000, mode 2777)
- seurat_tutorials (owner uid 1000, mode 2777)
- temp_columbus (owner uid 1000, mode 2777)
- training (owner uid 1000, mode 2777)
- tutorials (owner uid 1000, mode 2777)
- vitessce (owner uid 1000, mode 2777)
- waratchananj (owner uid 10041, mode 2777)
- webminars (owner uid 1000, mode 2777)
- work (owner uid 1000, mode 2777)
- zulip (owner uid 1000, mode 2777)

## Pure-local accounts on node1 (no LDAP match) — 11
- aa (uid 1004)
- admin (uid 1002)
- labuser01 (uid 2003)
- munge (uid 2001)
- nodeadmin (uid 1000)
- prome (uid 1003)
- slurm (uid 2002)
- testidu (uid 1001)
- thanponl (uid 1008)
- waratchananj (uid 1016)
- zulip (uid 2004)
