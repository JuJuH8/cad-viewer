# CAD Viewer

Éditeur de dessin web **DWG / DXF** aux commandes familières des utilisateurs de logiciels de DAO du marché
(projet indépendant, voir [Marques](#marques-et-indépendance)), rapide sur les gros fichiers, avec des
outils **MEP** : gaines, canalisations, chemins de câbles, débits, dimensionnement, pertes de charge, pentes
d'évacuation, supports, accessoires (registres, clapets coupe-feu…), raccordements maintenus, coupes, réservations,
interférences, métré avec pièces de forme, nomenclature, vue 3D.
Aucune installation ni compilation : une page HTML, des modules JavaScript et un petit serveur Python.

## Lancer

```bash
python serve.py
```

Puis ouvrir <http://localhost:8000>. Sous Windows, un double-clic sur **`Lancer CAD Viewer.bat`** fait les deux. On peut ouvrir directement un fichier :
`http://localhost:8000/?file=samples/D%C3%A9mo%20MEP.dxf` (fichiers de l'application seulement). Les fichiers de
`samples/` apparaissent dans « Exemples… ».

**Installation (Windows)** : lancer `CAD-Viewer-Setup-<version>.exe` (construit par `python -I scripts/build_exe.py`
puis `python -I scripts/build_installer.py`) : installation pour l'utilisateur, sans droits d'administrateur, dans
`%LOCALAPPDATA%\Programs\CAD Viewer`, raccourcis sur le Bureau et dans le menu Démarrer, inscription dans
« Applications installées » (désinstallation). Icône : `assets/icon.svg` (`python -I scripts/build_icon.py`).

Fenêtre d'application : `python cadviewer.py` démarre le serveur (port 8765) et ouvre l'appli dans une fenêtre
Microsoft Edge sans barre d'adresse ; fermer la fenêtre arrête le serveur. Version installable (un .exe, sans Python
ni .bat) : `python -I scripts/build_exe.py [version]` (PyInstaller) → `dist/CAD Viewer/CAD Viewer.exe` et une archive
ZIP ; copier le dossier « CAD Viewer » où l'on veut et lancer l'exe (Microsoft Edge requis, présent sur Windows). Les bibliothèques sont dans `vendor/` : l'application
fonctionne sans Internet (`python -I scripts/vendor.py` les retélécharge).

Tests automatisés : <http://localhost:8000/tests/index.html> (316 tests, environ une minute ; les tests de tracé
des fonds PDF demandent que la fenêtre du navigateur soit visible).
Banc d'essai de performance : <http://localhost:8000/tests/bench.html> (330 000 objets).

## Interface

Charte de l'interface : fond sombre #111110, clair #F2F1EC, rouge suisse #DA291C, angles vifs ; titres et sur-titres en
police ISO 3098 libre (osifont, embarquée), texte en Segoe UI. Thème **Auto** (comme Windows), **Clair** ou
**Sombre** par le bouton en haut à droite (retenu ; aussi `?theme=light|dark` dans l'adresse) ; le fond du dessin suit.
Barre du haut : menu **Fichier** (nouveau, ouvrir, enregistrer DXF / DWG, tracer, publier, exporter IFC, exemples) et
**recherche de commandes** (Ctrl+K : nom, alias ou libellé, ↑↓ et Entrée). Ruban : trois outils principaux par groupe
avec libellé, les autres en petites icônes (info-bulle). Angles légèrement arrondis.
**Panneaux Calques, Références et Propriétés** indépendants : ancrés à gauche ou à droite (largeur réglable par le
bord), **détachés** (bouton ou glisser la barre de titre ; déplaçables, redimensionnables par le coin, ancrés de
nouveau en les lâchant contre un bord) et **masquage automatique** (punaise : le panneau se réduit à un onglet sur le
bord, ou à sa barre de titre s'il flotte, et ressort au survol). Disposition retenue ; PANNEAUXDEFAUT la remet à
zéro. Tailles réglables : largeur des colonnes (poignée du bord), hauteur des panneaux empilés (séparateur), largeur
des panneaux sortis du bord (coin). Palette des **symboles électriques** dans un panneau latéral (SYMBOLE l'ouvre) ;
chaque symbole apparaît dès le clic (toute commande en plusieurs clics montre ce qui est déjà fait ; un seul Annuler
par commande). **Propriétés** à la manière d'AutoCAD : général, géométrie complète (Z, deltas, longueurs, aires en unités
du dessin et en m / m², sommets de polyligne modifiables un à un), textes, cotes, blocs ; sélection multiple : objets
par type, longueur et aire totales ; sections repliables. Ligne de commande **flottante** en bas
du dessin (options en pastilles cliquables, historique par F2 ou la flèche). `?run=COMMANDE` dans l'adresse lance des
commandes d'affichage à l'ouverture (démonstrations ; par sécurité, jamais une commande qui modifie le dessin ou
écrit un fichier).

## Vue 3D : coupes, mesures, filtres

Barre d'outils en haut à gauche de la vue 3D (bouton « Vue 3D ») :
- **Boîte de coupe** : autour de la sélection (un local, des réseaux…), sinon de tout le dessin ; toujours depuis le
  niveau du plan ; ses 6 faces se règlent en glissant les poignées rouges ; la caméra se cadre sur la boîte.
- **Plans de coupe** (6 au plus) : horizontal ou vertical (X, Y), côté gardé inversable, déplacé par sa poignée bleue.
- **Mesures** : point à point (distance, ΔX ΔY ΔZ), angle par 3 points (sommet en deuxième), **laser** (depuis une face,
  perpendiculairement, jusqu'au premier objet en face) ; en mètres ; Échap quitte l'outil.
- **Filtres** : dessin 2D, fonds de plan, grille, réseaux par système ; **isoler la sélection** ; réinitialiser.
- **Maquette IFC de l'architecte** : un fond de plan attaché depuis un fichier .ifc apparaît aussi en **volumes** (dalles,
  murs, poteaux…, couleurs de la maquette), placé comme son plan : le niveau du plan est à l'altitude 0 des réseaux.
  Par défaut, le niveau du plan avec sa dalle et la dalle du dessus (plafond) ; filtre « Tous les niveaux » pour tout le
  bâtiment, ou masqué. Les coupes s'y appliquent et les mesures s'y accrochent (laser du sol au plafond, d'un mur à
  l'autre). La première lecture d'une grosse maquette prend quelques secondes (fichier relu depuis sa source à la
  réouverture du dessin).

## Présentations : travailler dans une fenêtre

Comme l'espace objet flottant d'AutoCAD : **double-clic dans une fenêtre** d'une présentation → on travaille sur les
objets de l'espace objet à travers elle (sélection, accrochages, poignées, toutes les commandes ; les objets créés vont
dans l'espace objet), la feuille reste affichée autour, estompée ; ses objets ne sont pas accessibles. Molette et
bouton du milieu changent la vue de la fenêtre (gardée en revenant ; fenêtre verrouillée : vue figée) ; les calques
gelés dans la fenêtre restent masqués. Retour à la feuille : **double-clic hors de la fenêtre**, Échap sans
sélection, ESPACEP (EP) ou un autre onglet ; ESPACEO (EO) pour entrer sans double-clic.

## Utilisation (comme AutoCAD)

- **Ligne de commande** flottante en bas du dessin : tapez une commande ou son alias puis Entrée (ou Espace). Entrée à vide
  répète la dernière commande ; Échap annule. Les options entre crochets se choisissent par leur lettre
  en majuscule (ex. `c` pour « Clore ») ou en cliquant dessus.
- **Clic droit** : pendant une commande, = Entrée. Sans commande, **menu contextuel** : sur un objet (il est sélectionné)
  ou une sélection, **« Dessiner un(e) … »** en tête — par exemple « Dessiner une canalisation EF Ø32 », « Dessiner un
  chemin de câbles CFO 300×60 », « Dessiner un tube TUB-CFO M20 noyé en dalle » : même réseau, section, altitude et
  coudes, sans question (commande AJOUTSELECT) ; pour une ligne, un cercle… mêmes calque et couleur ; pour un bloc ou un
  symbole, même bloc et mêmes données (circuit) —, puis Déplacer, Copier, Rotation, Échelle, Miroir, Décaler, Étirer,
  Effacer, presse-papiers, Isoler, Propriétés. Dans le vide : Répéter la dernière commande, Annuler, Rétablir, Coller,
  Tout sélectionner, Zoom étendu.
- **Saisie des points** : clic, `x,y`, `@dx,dy` (relatif), `@distance<angle` (polaire), ou un nombre seul
  (distance dans la direction du curseur).
- **Ligne de commande** : saisie semi-automatique (↑↓ pour choisir, Tab pour compléter) ; **AIDE** (F1) liste
  les 126 commandes avec leurs alias (413) et un filtre.
- **Accrochages** (F3) : extrémité, milieu, centre, quadrant, intersection, perpendiculaire, nodal, insertion.
- **Repérage d'accrochage** (F11, REPÉRAGE) : survolez un point d'accrochage pour l'acquérir (croix turquoise) ;
  le curseur s'aligne sur ses horizontales / verticales (ou angles polaires) et sur l'intersection de deux
  alignements ; une distance tapée se reporte le long de l'alignement.
  **ORTHO** (F8), **POLAIRE** (F10).
- **Sélection** : clic (ajoute), Maj+clic (retire), fenêtre gauche→droite (objets entièrement dedans),
  capture droite→gauche (objets touchés), Ctrl+A. Suppr efface. Les **poignées** bleues s'étirent au clic.
- Molette : zoom ; bouton du milieu : panoramique ; double-clic molette : zoom étendu.
- Ctrl+Z / Ctrl+Y : annuler / rétablir · Ctrl+C / Ctrl+V : copier / coller · Ctrl+S : enregistrer en DXF.
- **Double-clic** sur un objet : il est sélectionné et le champ utile de la palette Propriétés est prêt à être
  modifié (texte, rayon, section d'un réseau…).
- **Calques** : clic sur le rond = calque courant ; carré de couleur = palette AutoCAD ; double-clic sur le nom =
  renommer ; × = supprimer un calque vide. Tout est annulable.
- **Sauvegarde automatique** chaque minute dans le navigateur : au redémarrage, l'application propose de
  récupérer le dernier dessin.

### Commandes

| Dessin | Modification | Annotation | MEP | Outils |
|---|---|---|---|---|
| LIGNE (L) | DEPLACER (M) | TEXTE (TX) | GAINE (GA) | ANNULER (U) |
| POLYLIGN (PL), arcs inclus | COPIER (CO) | COTLIN (DLI) | CANALISATION (CA) | RETABLIR (REDO) |
| CERCLE (C) : centre, 2P, 3P | ROTATION (RO) | COTALI (DAL) | CHEMINCABLE (CDC) | DISTANCE (DI) |
| ARC (A) : 3 points, centre | ECHELLE (SC) | COTRAYON (DRA) | CONVMEP (CONV) | LISTE (LI) |
| RECTANG (REC), POLYGONE (POL), NUAGEREV (REVCLOUD) | MIROIR (MI) | COTDIA (DDI) | INTERFERENCES (CLASH), COUPE, RESERVATIONS, HAUTEURLIBRE (HSP) | ZOOM (Z) |
| ELLIPSE (EL), SPLINE (SPL) | DECALER (O) | HACHURES (H) | METRE (MET), NUMEROTER, NOMENCLATURE, SUPPORTS (SUP), ACCESSOIRE (ACC) | ECHELLEANNO (ECH) |
| POINT (PO), ANNEAU (DO), DROITE (XL), DEMIDROITE (RAY) | AJUSTER (TR), PROLONGER (EX) | COTCONT (DCO), COTLIGNEBASE (DBA) | | ENREGDXF (Ctrl+S) |
| | | | | PURGER (PU), SUPPRDOUBLONS (OVERKILL), SELECTRAPIDE (QSELECT) |
| | RACCORD (F) : lignes, polylignes, arcs, cercles ; CHANFREIN (CHA) | | | ISOLERCALQUE (LAYISO), ANNULISOLER |
| | ETIRER (S), COUPURE (BR), COUPUREPOINT (BRP) | | | CALQUEOFF, CALQUEGEL, CALQUEON, UNITES (UN) |
| | RESEAU (AR) : rectangulaire, polaire, trajectoire ; MODIFLONG (LEN) ; ALIGNER (AL) ; MODIFTEXTE (ED) ; EDITPOLY (PE) | | | ECHLTP (LTS), ID, REGEN (RE), COUPERPRESSE (Ctrl+X), COPIERBASE (COPYBASE), COLLERORIG (PASTEORIG), ISOLEROBJETS / MASQUEROBJETS / FINISOLEROBJETS, CALQCOUR (LAYMCUR), CORRESPCALQUE (LAYMCH), FUSIONCALQUE (LAYMRG), SUPPRCALQUE (LAYDEL) |
| | JOINDRE (J), DECOMPOS (X), EFFACER (E), GROUPE (G), DEGROUPER | BLOC (B), INSERER (I), DEFATT (ATT) | RETOUR (RET), BOUCHE (BO), RACCORDER, APPAREIL (APP), EMETTEUR (EM), DEBITS, DIMENSIONNER (DIMRES), PERTESCHARGE (PDC), PENTE | |
| | RESEAURECT (AR), RESEAUPOLAIRE (RP), CORRESPROP (MA) | LIGNEREPERE (LE) | ETIQMEP (ETIQ) | |
| | DIVISER (DIV), MESURER (MES) : points ou blocs (bouches) | | | |

### MEP

- **Systèmes** : soufflage, reprise, air neuf, extraction, rejet, chauffage et eau glacée (départ / retour),
  EF, ECS, bouclage, EU, EV, EP, gaz, sprinkler, chemins de câbles courants forts / faibles. Chaque système
  a son calque `MEP-<domaine>-<code>`, créé automatiquement avec sa couleur et son type de ligne
  (réseaux de retour en tirets).
- **GAINE** : système, section (`400x200` ou `Ø250`), altitude, puis le tracé point par point. Le double
  trait, les coudes et l'étiquette de section sont générés automatiquement.
- **CONVMEP** : transforme des lignes / polylignes existantes (plans d'un bureau d'études) en réseaux ;
  les morceaux bout à bout deviennent un seul réseau.
- **Piquages** : une gaine (ou un chemin de câbles) qui démarre ou finit sur une autre s'arrête sur sa paroi ; la
  paroi du réseau porteur s'interrompt (té ouvert). **Coudes à rayon** automatiques (gaine : rayon d'axe = largeur),
  ou à onglet au choix (Propriétés → Coudes).
- **CHEMINCABLE** : système, section (`300x60`), altitude du dessous, puis le tracé. Tronçons droits, un coude à
  chaque changement de direction (angles libres), au **rayon du catalogue** : option « Coudes » au point de départ
  (OBO, Lanz ou à onglet, retenu pour les suivants), modifiable par chemin dans les Propriétés (fabricant, rayon
  intérieur). Un coude qui ne tient pas entre deux changements de direction n'est pas réduit : il est dessiné à
  onglet et signalé (commande, Propriétés, METRE « Coude 90° à onglet »). Rayons intérieurs : OBO 150 mm
  (coude RB 90) ; Lanz 150 mm **provisoire, à confirmer avec le catalogue**. Supports, métré et 3D suivent les coudes.
- **RETOUR** : réseau de retour parallèle à l'entraxe voulu, du côté choisi (chauffage / eau glacée départ →
  retour, ECS → bouclage, soufflage → reprise), même section et altitude.
- **BOUCHE** : terminaux paramétriques (diffuseur carré, grille de reprise, bouche d'extraction, diffuseur
  circulaire) avec leur **débit** (m³/h, modifiable dans Propriétés), comptés au métré par type et dimension.
- **RACCORDER** : branchement automatique de chaque bouche sur la gaine la plus proche de son système (piquage
  perpendiculaire arrêté sur la paroi, gaine circulaire dimensionnée sur le débit de la bouche à la vitesse choisie).
- **DEBITS** : on clique la gaine de départ (côté CTA) ; les débits des bouches sont cumulés jusqu'à
  l'origine en suivant les raccordements bout à bout et les piquages. Chaque gaine affiche son débit
  (« 400×200 — 1200 m³/h ») ; Propriétés donne aussi la vitesse. Les bouches trop loin d'une gaine du
  même système sont signalées et sélectionnées.
- **DIMENSIONNER** : même calcul, puis sections recalculées à vitesse maximale (4 m/s par défaut ;
  hauteur conservée en rectangulaire, diamètres normalisés en circulaire). Les gaines sont découpées
  **après chaque piquage** où le débit baisse : les réductions se dessinent seules et les piquages sont
  recalés sur les nouvelles parois. Résultat validé dans AutoCAD (0 erreur, débits conservés en DWG).
- **Montées / descentes** : deux réseaux raccordés bout à bout à des altitudes différentes sont reliés par un tronçon
  vertical en 3D ; en plan, symbole à la section (une diagonale = montée, deux = descente), écrit aussi en DXF.
  PERTESCHARGE compte la hauteur et deux coudes, le METRE deux coudes à 90°.
- **Raccordements maintenus** : déplacer, étirer ou redimensionner une gaine ou une canalisation emmène les
  réseaux du même système qui y sont raccordés (piquage recalé sur la nouvelle paroi, prolongement bout à bout
  qui suit l'extrémité), en cascade (un piquage posé sur un prolongement étiré est recalé lui aussi) ; un seul
  « annuler » revient en arrière. Index spatial : 40 gaines déplacées d'un coup et 1 900 piquages recalés en ~16 ms.
- **APPAREIL** : appareils sanitaires (lavabo, évier, douche, baignoire, WC, urinoir, lave-linge…) avec leurs
  débits de base DTU 60.11 en eau froide / eau chaude. **DEBITS** et **DIMENSIONNER** fonctionnent aussi sur les
  canalisations : débit probable avec le coefficient de simultanéité y = 0,8 / √(n − 1), diamètres intérieurs
  courants (10 à 150 mm) à vitesse maximale (1,5 m/s par défaut), étiquettes « Ø16 EF — 0,29 l/s ».
- **PENTE** : réseaux d'évacuation gravitaires (EU, EV, EP…) — on clique la canalisation au point bas (rejet,
  chute) et on donne son altitude et la pente (1 % EU / EP, 2 % EV par défaut) ; le réseau remonte vers les
  appareils en suivant les raccordements, fils d'eau alignés aux piquages. Chaque canalisation garde ses altitudes
  de début et de fin (Propriétés : « Altitude fin », pente affichée), étiquette « Ø100 EU — pente 1 % », coupe,
  vue 3D et interférences tiennent compte de la pente ; DIMENSIONNER conserve les altitudes des morceaux.
- **CALORIFUGEAUTO** : calorifuge des canalisations selon le système et le diamètre (chauffage / ECS 20 à 50 mm,
  eau glacée 19 à 32 mm — valeurs indicatives à adapter au CCTP).
- **EMETTEUR** : radiateurs, ventilo-convecteurs, batteries de CTA sur les réseaux de chauffage / eau glacée ;
  débit = puissance / (ρ·c·ΔT) (ΔT 10 K en chauffage, 5 K en eau glacée par défaut), additionné sans
  simultanéité par DEBITS / DIMENSIONNER.
- **PERTESCHARGE** : pertes de charge de l'origine à chaque bouche — frottement (Darcy-Weisbach, Altshul-Tsal,
  acier galvanisé, air à 20 °C ; 400×200 à 1 000 m³/h → 0,60 Pa/m comme les abaques), coudes, tés et perte
  propre des bouches. Le chemin critique est sélectionné ; la liste donne, pour chaque bouche, la perte à
  créer au registre pour équilibrer le réseau (export CSV pour Excel).
  Sur les canalisations : eau à 20 °C (Ø 20 à 0,2 l/s → 0,3 kPa/m), débits probables en sanitaire, pression
  nécessaire aux appareils et hauteur statique ; résultat en kPa (pression à fournir à l'origine).
- **CORRESPROP** (MA) sur des réseaux : système, section, altitude et calorifuge du réseau source reportés.
- **ETIQMEP** : étiquette avec ligne de rappel « SOUF 400×200 — Z +2,70 m » ; option **Tous** pour étiqueter
  d'un coup tous les réseaux visibles.
- **Calorifuge** (Propriétés, épaisseur en mm) : contour en tirets autour de la gaine ou de la canalisation,
  compris dans la détection d'interférences et conservé en DXF / DWG.
- **COUPE** : tracez une ligne de coupe en plan ; la coupe des réseaux est dessinée à l'échelle 1:1 à l'endroit
  choisi — sections des gaines (avec croix), canalisations et chemins de câbles à leur altitude (largeur
  apparente si la coupe est oblique, calorifuge compris), réseaux vus en élévation dans la profondeur de vue,
  étiquettes « SOUF 400×200 / Z +2,70 », niveau ±0,00 et repères A-A en plan ; murs coupés (calques MUR / WALL /
  CLOISON…, xrefs comprises) en bandes hachurées sur la hauteur d'étage.
- **RESERVATIONS** : plan de réservations — traversées des murs (calques automatiques MUR / WALL / CLOISON /
  VOILE ou choisis, xrefs et blocs compris) ; les deux faces d'un mur donnent une réservation (épaisseur du mur),
  taille = réseau + calorifuge + jeu ; symboles sur le calque MEP-RESERVATIONS, liste avec zoom, export CSV.
- **INTERFERENCES** : conflits entre réseaux de systèmes différents, en plan **et** en altitude, avec un jeu
  minimal au choix ; cliquer une ligne de la liste zoome sur le conflit ; rapport CSV (colonne Statut pour la réunion
  de synthèse) et repères numérotés dans le dessin (calque MEP-INTERFERENCES).
- **HAUTEURLIBRE** (HSP) : réseaux dont le dessous (calorifuge et pente compris) passe sous une hauteur donnée
  (faux plafond, passage) — liste avec zoom, réseaux sélectionnés.
- **METRE** : longueurs, tronçons et coudes par système et par section, puis les pièces de forme — coudes par
  angle (arrondi à 5°), réductions (« 600×300 → 400×300 »), piquages / tés (« 300×200 sur 600×300 »), bouches,
  appareils et supports ; export CSV pour Excel. **TABLEMETRE** insère le métré (ou la nomenclature) comme tableau
  dans le dessin ou sur une présentation (bloc déplaçable, validé AutoCAD).
- **NUMEROTER** : repère chaque pièce (SOUF-001, EF-002…) dans une bulle dessinée avec le réseau (conservée en
  DXF / DWG) ; **NOMENCLATURE** : liste des pièces (section, longueur, coudes, calorifuge, altitude), export CSV.
- **ACCESSOIRE** : accessoires en ligne mis à la section du réseau — registres, clapets coupe-feu, silencieux
  (gaines), vannes (canalisations) ; option **Murs** : un clapet coupe-feu à chaque traversée de mur. Comptés au
  METRE et dans PERTESCHARGE (ζ : registre 0,3, clapet coupe-feu 0,5, silencieux 1,0, vanne 0,2), conservés en DXF
  (validé AutoCAD).
- **SUPPORTS** : supportage automatique (comme les « hangers » de CADmep) — suspentes trapèze sur les gaines
  rectangulaires, colliers sur les gaines circulaires et les canalisations, consoles sur les chemins de câbles ;
  à 30 cm des extrémités et de la fin de chaque coude, puis à l'entraxe maximal du réseau (gaines 3 m, 2,4 m
  au-delà de 1 000 mm ; chemins de câbles 1,5 m ; tubes de 1,25 à 3 m selon le diamètre ; PVC d'évacuation
  10 × D) ou à un entraxe imposé ; demi-entraxe de part et d'autre d'une jonction bout à bout. Relancer la
  commande remplace les supports. Comptés au **METRE**, paramètres dans Propriétés, conservés en DXF (validé AutoCAD).
- **Vue 3D** : les réseaux deviennent des volumes à leur altitude (inclinés s'ils sont en pente) ; bouches, appareils
  et émetteurs en plaques, calorifuge en enveloppe translucide, supports (traverse et tiges) et accessoires en volume.
- La palette **Propriétés** permet de changer système, section, altitude, calorifuge d'un réseau — ou de
  plusieurs à la fois (valeurs différentes affichées « *DIVERS* »).
- À l'enregistrement, les réseaux sont écrits comme des blocs (le dessin est identique dans AutoCAD) avec leurs
  paramètres en données étendues : rouverts dans l'application — même après être passés par AutoCAD —
  ils redeviennent des réseaux modifiables.

## Ce qui est lu et écrit

- Lecture : DWG de R13 à 2018+ (`AC1032`, AutoCAD 2018–2025) et DXF ; dans des Web Workers (interface fluide,
  conversion parallèle des gros DWG).
- Affichage fidèle : blocs imbriqués, attributs, hachures pleines et à motifs, textes et textes multilignes,
  cotes, tableaux, types de ligne, présentations (espace papier), fonds PDF et images joints.
- Écriture : **DXF 2007 (UTF-8)**, validé dans AutoCAD 2024 (ouverture, AUDIT sans erreur, réenregistrement DWG)
  sur tous les exemples.
- **Enregistrer DWG** (DWG 2018) : si AutoCAD est installé sur le PC, le serveur local lui fait convertir le DXF
  (AutoCAD sans interface, `accoreconsole.exe`, ≈ 1,5 s). Sans AutoCAD, la commande l'indique et on utilise le DXF.

## Tracé PDF

**TRACER** ouvre la boîte de tracé, comme celle d'AutoCAD (**-TRACER** : questions en ligne de commande) :

- périphérique PDF vectoriel ; format (ISO, formats ajoutés) et orientation, ou la feuille de la mise en page
  pour une présentation (bouton « Mise en page… ») ;
- zone de tracé : présentation (feuille au 1:1), étendue, affichage ou fenêtre choisie dans le dessin ;
- échelle : ajustée au format ou normalisée (1:1 à 1:10 000) ;
- **table de styles de tracé** (CTB) : aucune, ou une table intégrée (acad, monochrome, grayscale, trame 50 %,
  « CV noir - épaisseurs par couleur ») ou de l'utilisateur ; Modifier…, Nouvelle…, Importer .ctb…, Exporter .ctb ;
- options : tracer avec les styles de tracé, les épaisseurs, la transparence ; cadre et cartouche (espace objet) ;
- **Aperçu** du PDF dans la boîte ; « Appliquer » garde les réglages (mise en page de la présentation, ou dessin).

**Styles de tracé** (tables dépendant de la couleur, comme les .ctb d'AutoCAD) : pour chacune des 255 couleurs,
couleur tracée (celle de l'objet ou imposée : noir, blanc, autre), tramage, niveaux de gris, trame (%), type de
ligne (celui de l'objet ou l'un des 31 types des styles de tracé), épaisseur (celle de l'objet ou imposée).
L'éditeur montre les 255 couleurs ; on en choisit une ou plusieurs (Maj / Ctrl) et on règle leurs propriétés.
Les fichiers **.ctb d'AutoCAD** se lisent et s'écrivent : une table exportée par l'appli est identique au fichier
d'AutoCAD (texte et somme de contrôle). La mise en page d'une présentation garde sa table (écrite dans le DXF) et
peut **afficher les styles de tracé à l'écran** (couleurs et, avec ÉPAISSEUR, épaisseurs tracées).

Les calques non traçables (POINTSDEF…) sont ignorés ; « Défaut » = 0,18 mm. **PUBLIER** : toutes les présentations
dans un seul PDF, chacune sur sa feuille et avec sa table de styles.

## Références externes (xrefs)

Onglet **Références** du panneau de gauche (à côté de Calques), comme la palette Références externes d'AutoCAD :

- chaque fond de plan (base DWG, DXF ou IFC attachée) et chaque xref d'un fichier ouvert, avec son état
  (chargée, introuvable, nouvelle version disponible), son fichier, sa version et son nombre d'objets ;
- un clic sélectionne la référence et ses insertions, un double-clic zoome dessus ;
- actions : Recharger, Nouvelle version…, Chemin… (changer de fichier), Zoom, Retirer (annulable), Afficher,
  Verrouiller, Atténuer ; « + Attacher », « Tout recharger », « Gestionnaire… » (boîte FOND complète).

À l'ouverture, les fichiers des xrefs sont cherchés **à côté du dessin** (même dossier) et chargés
automatiquement ; sinon « Charger… » (panneau) ou le bouton de la barre d'état permet de les choisir. Leurs
calques sont préfixés comme dans AutoCAD (`Wall Base|MUR`). À l'enregistrement, les xrefs d'un fichier ouvert
sont **liées** ; les fonds de plan à chemin connu restent de vraies références externes.

## Fonds PDF et images (ATTACHER)

Comme PDFATTACH / IMAGEATTACH d'AutoCAD : **ATTACHER** (ruban Annoter › Références, ou « + PDF / image » du panneau
Références) joint un **PDF** (une page) ou une **image** (PNG, JPG, BMP, GIF, WebP) en fond, sous le dessin.

- **Pose** : fichier choisi (« Parcourir… ») ou chemin complet (lu par le serveur de l'appli), page avec aperçus,
  échelle du plan (« 1:50 » : taille réelle selon les unités du dessin), facteur, largeur (images) ou **par référence**
  (deux points du fond — accrochage aux traits du PDF — puis leur longueur réelle), rotation, calque propre au fond.
  **-ATTACHER** : mêmes questions en ligne de commande.
- **Affichage net à tout zoom** : texture de la page à ≈ 200 ppp, puis la zone visible redessinée à la résolution de
  l'écran quand on arrête de zoomer. Rendu du PDF par pdf.js (Mozilla).
- **Réglages** (palette Propriétés, AJUSTERFOND) : échelle, plan au 1:N, rotation, position, estompage (0–80 %),
  contraste, monochrome, **couleurs adaptées au fond sombre** (traits noirs affichés en blanc, comme AutoCAD),
  blanc transparent, affiché ; page d'un PDF.
- **Calques du PDF** (CALQUESFOND, comme ULAYERS) : les calques d'un PDF tracé par AutoCAD (A-MURS, MEP-…) affichés
  ou masqués, à l'écran, à l'accrochage, au tracé et à l'import.
- **Découpe** (DECOUPFOND, comme PDFCLIP / IMAGECLIP) : rectangle ou polygone, intérieur ou extérieur gardé (inversée),
  désactivée, supprimée.
- **Accrochage** aux traits du PDF : extrémité, milieu, intersection, perpendiculaire, proche.
- **Tracé** (TRACER, PUBLIER, présentations) : fond rendu en image (200 ppp) sous les traits, réglages appliqués ;
  le cadre n'est pas tracé. Dans une présentation, un fond de l'espace objet apparaît dans les fenêtres.
- **Panneau Références** : chaque fichier joint avec son état (chargé, introuvable), Recharger, Rechercher… (fichier
  déplacé), Chemin…, Calques…, Zoom, Détacher, Affiché.
- **DXF / DWG** : écrits comme AutoCAD (PDFUNDERLAY + PDFDEFINITION, IMAGE + IMAGEDEF, découpes, réglages) et relus
  (DXF et DWG d'AutoCAD, découpes comprises) — validé dans AutoCAD 2024 : objets reconnus, emprises exactes, AUDIT 0,
  réenregistrés par AutoCAD puis relus à l'identique. À l'ouverture, les fichiers sont cherchés par leur chemin
  (serveur de l'appli), par le fichier déjà choisi dans le navigateur, puis à côté du dessin.

**PDFIMPORT** convertit un fond PDF (tout ou une zone) en objets : lignes, polylignes avec arcs, arcs et cercles
reconnus, hachures pleines, textes ; couleurs (index AutoCAD), épaisseurs, **calques du PDF** (ou calques
« PDF_… », ou calque courant) ; le fond est gardé ou retiré ; annulable. Sur un plan tracé par AutoCAD au 1:100, les
murs importés sont à moins de **0,02 mm du papier** du dessin d'origine, les textes à leur calque et à leur hauteur.

## Découpe des blocs et références (DECOUPXREF)

**DECOUPXREF** (XCLIP) découpe une insertion de bloc, une référence externe ou un fond de plan : contour
rectangulaire, polygonal ou polyligne fermée, découpe **inversée** (garder l'extérieur), activée / désactivée,
supprimée, ou recopiée en polyligne. Le contour suit l'insertion (déplacer, tourner). La géométrie est découpée à
l'écran, à la sélection, à l'accrochage et au tracé ; le cadre est affiché, pas tracé (comme XCLIPFRAME = 2).
DXF comme AutoCAD : filtre spatial (SPATIAL_FILTER) et, pour une découpe inversée, son enregistrement d'aller-retour —
relus par AutoCAD 2024 (AUDIT 0, découpe inversée reconnue, tracés identiques) ; découpes faites dans AutoCAD
relues (DXF et DWG). Palette Propriétés : état de la découpe et bouton « Découper… ».

## Démo MEP

`samples/Démo MEP.dxf` et `.dwg` (menu **Exemples**) : un plateau de bureaux avec soufflage dimensionné
(2 250 m³/h, réductions après chaque piquage), extraction des sanitaires, eau froide (débits probables),
étiquettes, note et présentation A3 au 1:100 — dessiné uniquement avec les commandes de l'application
(`tests/demo-mep.js`), validé par AutoCAD (0 erreur) puis réenregistré en DWG par AutoCAD.
Dans `docs/`, la même présentation A3 tracée par **AutoCAD** (`-PLOT`, DWG To PDF) et par **CAD Viewer** (TRACER) :
les deux rendus sont identiques.

## Blocs et attributs

- **BLOC** crée un bloc ; **INSERER** ouvre la boîte d'insertion : aperçu de chaque bloc, recherche, échelle,
  rotation (ou à l'écran), décomposer, insertion répétée, bloc depuis un fichier DWG / DXF (-INSERER : ligne de
  commande). La valeur de chaque attribut est demandée (valeur par défaut proposée) ; les valeurs se modifient
  dans **Propriétés** (cartouches, repères de locaux).
- Les définitions d'attributs (ATTDEF) des DWG / DXF sont conservées ; **DEFATT** en crée ; **SYNCATT** (ATTSYNC)
  met les insertions à jour après un changement de définition. Validé dans AutoCAD.
- **Éditeur de blocs** (EDITBLOC, ou double-clic sur un bloc sans attribut) : la définition s'ouvre seule, en
  coordonnées du bloc, avec une barre d'outils en haut du dessin. Toutes les commandes de dessin et de
  modification y fonctionnent, avec leur propre historique d'annulation. BPOINTBASE déplace le point de base.
  **BENREG** remplace la définition (une étape d'annulation dans le dessin, attributs des insertions synchronisés),
  **BFERMER** referme (en proposant d'enregistrer).
- **EXTRACTATT** (DATAEXTRACTION) : extraction des données des blocs — tout le dessin ou la sélection, blocs
  imbriqués compris si voulu, choix des blocs (avec leur nombre) et des colonnes : nombre, nom, calque, position,
  rotation, échelle, espace, **attributs** et **paramètres des blocs dynamiques** ; lignes identiques regroupées,
  tri par un clic sur l'en-tête, aperçu. Sorties : **CSV pour Excel** (« ; », décimales à virgule), copie pour
  coller dans Excel, ou **tableau dans le dessin**. Le tableau garde ses réglages (dans le DXF aussi) :
  **MAJEXTRACTION** (DATALINKUPDATE) le recalcule après des modifications, en une étape d'annulation. Validé dans
  AutoCAD (AUDIT 0, tableau tracé à l'identique).

## Blocs dynamiques

Paramètres et actions ajoutés dans l'éditeur de blocs, sur le principe d'AutoCAD :

| Paramètre | Poignée sur l'insertion | Actions |
|---|---|---|
| **PARAMLIN** (linéaire) | flèche | Étirer (cadre + objets), Déplacer, Échelle |
| **PARAMPOINT** (point) | carré | Déplacer, Étirer |
| **PARAMROT** (rotation) | cercle | Rotation |
| **PARAMINV** (inversion) | double flèche (clic) | Inversion (symétrie) |
| **VISIBILITE** (états) | triangle (liste des états) | objets montrés / cachés par état |
| **PARAMCONSULT** (table) | triangle (liste des choix) | règle plusieurs paramètres d'un coup |

- **Visibilité** : plusieurs paramètres de visibilité par bloc, aux états indépendants (BVPARAM ; un objet est caché
  si l'un d'eux le cache). Gestionnaire (VISIBILITE → « Gérer… ») : grille objets × états (case cochée = visible),
  ajout d'un état (comme l'état affiché, tout visible ou tout caché), duplication, renommage, ordre (le premier
  état est celui des nouvelles insertions), suppression, « tout / rien » par état, objet visible partout ; le survol
  d'une ligne repère l'objet. BVNOUVEAU, BVCACHER / BVMONTRER, BVMODE, BVCOURANT, BVACTIF en ligne de commande.
  Les attributs se cachent avec leur définition.
- **Tables de consultation** (PARAMCONSULT) : des choix nommés (« Bureau 180 sans écran »…) qui règlent d'un coup
  longueurs, rotations, inversions et états ; sur l'insertion, poignée triangle ou Propriétés ; un réglage manuel
  qui ne correspond à aucune ligne affiche « Personnalisé ».
- Valeurs admises d'un paramètre linéaire (BPARAMETRES) : libre, bornes min / max, pas, ou liste de valeurs.
- Sur une insertion : les poignées cyan règlent les paramètres (glisser, ou cliquer pour l'inversion et la liste
  des états) ; Propriétés → « Personnalisé » donne les valeurs. Les attributs suivent les actions qui les déplacent.
- **Enregistrement** : chaque variante utilisée est écrite comme un bloc figé (géométrie évaluée), qu'AutoCAD et
  tout logiciel affichent ; les définitions dynamiques et les valeurs sont conservées (dictionnaire et XDATA).
  À la relecture, dans l'appli, les insertions redeviennent dynamiques. Validé : DXF → AutoCAD (AUDIT 0, variantes
  tracées) → DWG enregistré par AutoCAD → relu par l'appli avec ses paramètres.
- **Blocs dynamiques d'AutoCAD** (DXF et DWG) : paramètres de **visibilité, linéaire, point, rotation, inversion**
  et **tables de consultation**, avec leurs actions (**déplacer, étirer, échelle, rotation, inversion**), relus et
  convertis en paramètres de l'appli. Comme dans AutoCAD, une action transforme aussi les paramètres de son jeu de
  sélection (la rotation du symbole emporte le paramètre qui l'étire, le déplacement des libellés emporte leur
  rotation…). Chaque insertion retrouve ses valeurs, qui se modifient ensuite dans l'appli : poignées cyan,
  Propriétés → « Personnalisé » (mêmes valeurs que dans AutoCAD : distances, angles, position X / Y des points,
  ligne de la table de consultation). Un texte inversé reste lisible, comme dans AutoCAD.
- **Fidélité contrôlée à l'ouverture** : la géométrie calculée par l'appli est comparée objet par objet à la
  représentation enregistrée par AutoCAD ; si elle diffère, l'insertion garde la représentation d'AutoCAD (sous son
  **nom effectif** dans Propriétés et EXTRACTATT, au lieu du nom anonyme *U). Les objets invisibles des
  représentations (code 60) sont respectés.
- Vérifié sur une bibliothèque électrique du commerce (1 878 insertions, 689 définitions) → 1 784 insertions converties, 0 écart
  (les 18 autres utilisent des paramètres polaires, réseaux ou contraintes, non gérés : représentation d'AutoCAD
  gardée) ; 21 insertions modifiées dans AutoCAD puis modifiées à nouveau des deux côtés (appli et AutoCAD) :
  géométrie et valeurs des propriétés identiques ; bloc d'essai créé dans AutoCAD (étirement, déplacement, rotation,
  inversion de tout le bloc) en DXF et DWG.
- Limites : tables de consultation lues seulement dans les DXF (LibreDWG ne les décode pas dans les DWG : le
  paramètre de consultation y manque, les autres paramètres restent modifiables) ; paramètres polaires, XY,
  alignement, réseaux et contraintes non gérés ; position d'un texte inversé à environ 1 % de sa hauteur près
  (cadre du texte mesuré avec la police de l'appli) ; à l'enregistrement, les paramètres de l'appli ne sont pas des
  paramètres AutoCAD (dans AutoCAD, chaque variante est un bloc simple).

## Styles de tracé nommés (STB)

Les dessins en **styles de tracé nommés** d'AutoCAD (PSTYLEMODE = 0) sont relus et écrits : style de chaque calque
(« Normal », « Style 1 »…) et styles imposés à des objets (DXF ; dans les DWG, ceux des calques seulement : LibreDWG
décode mal ceux des objets). Le tracé (TRACER, PDF) et l'aperçu des présentations appliquent la table **.stb** choisie :
style de l'objet, sinon celui de son calque. La boîte Tracer propose les tables .stb dans ces dessins (.ctb sinon) :
modifier (liste de styles : ajouter, renommer, supprimer ; « Normal » est fixe), créer, importer et exporter des
fichiers .stb au format d'AutoCAD. Gestionnaire des calques : colonne « Style de tracé » ; Propriétés : style de l'objet
(DuCalque par défaut). **CONVSTYLESTRACE** (CONVERTPSTYLES) fait passer un dessin d'un mode à l'autre. Tables
intégrées : acad.stb, monochrome.stb, « CV styles nommés.stb » (noir, gris tramés, traits fin / moyen / fort).

## Cotes associatives

COTLIN, COTALI (points pris par accrochage), COTRAYON et COTDIA restent liées aux objets : étirer,
déplacer ou modifier l'objet met la cote à jour (longueur, texte, position) dans la même étape
d'annulation ; déplacer l'objet et sa cote ensemble ne la décale pas deux fois.

**Compatibilité AutoCAD** (DXF et DWG) :
- les cotes linéaires, alignées, de rayon et de diamètre d'AutoCAD sont relues avec leurs points de définition et
  leurs objets accrochés (objets DIMASSOC, cotes associatives d'AutoCAD) : elles se mettent à jour dans l'appli
  quand leurs objets bougent, comme dans AutoCAD (mêmes mesures vérifiées après les mêmes modifications) ;
- à l'enregistrement, ces cotes (relues ou créées dans l'appli) sont écrites comme de **vraies cotes** d'AutoCAD,
  avec leurs objets accrochés : dans AutoCAD, elles restent modifiables et associatives (déplacer l'objet met la
  cote à jour) ; le style de cote Standard reprend les réglages de l'appli (format, tailles, échelle) pour qu'AutoCAD
  les redessine à l'identique, et DIMASSOC = 2 est écrit pour les nouvelles cotes.
- Points accrochés écrits : extrémités et milieux (lignes, arcs, segments de polyligne), centres (cercles, arcs),
  points nodaux et points d'insertion. Les cotes angulaires et d'ordonnée restent des blocs (affichage seul).

## Champs (CHAMP)

- **CHAMP** (FIELD) : texte dont une partie est calculée — **nom du fichier** (sans / avec extension, majuscules,
  chemin), **date** du jour, d'**enregistrement** ou de **tracé** (formats français : 16.10.2026, 16 octobre 2026…),
  **nom de la présentation**, **échelle d'une fenêtre** (1:100), **attribut d'un bloc** (cartouche), contenu d'un
  texte, **aire** (m²) ou **longueur** d'un objet. Boîte de choix avec aperçu ; le champ crée un texte, ou s'ajoute
  au texte sélectionné. **-CHAMP** en ligne de commande, **MAJCHAMP** (UPDATEFIELD) pour recalculer.
- Mise à jour automatique : à l'ouverture, à l'enregistrement (date, nom), au tracé (date de tracé, présentation)
  et quand l'objet cité change (attribut modifié, fenêtre rezoomée, polyligne étirée), dans la même étape
  d'annulation. Fond gris à l'écran (jamais tracé), comme AutoCAD ; un texte retouché à la main redevient fixe.
- Fichiers : champs écrits comme AutoCAD (objets FIELD, codes d'AutoCAD, valeurs en cache, somme de contrôle,
  liste des champs) ; champs des DXF et DWG d'AutoCAD relus avec leurs objets cités. Validé AutoCAD 2024 :
  AUDIT 0, les champs de l'appli sont de vrais champs et AutoCAD recalcule les mêmes valeurs.

## SCU (système de coordonnées utilisateur)

- **SCU** (UCS) : origine (et point de l'axe X), rotation **Z**, aligné sur un **OBjet** (ligne, polyligne, arc,
  cercle, texte, bloc), **Précédent**, **Général** (Entrée), SCU **NOmmés** (enregistrer, restaurer, supprimer,
  liste). Raccourcis du ruban (Outils › SCU) : SCUOBJET, SCUPRECEDENT, SCUGENERAL ; **SCUICONE** (UCSICON) :
  icône affichée ou non, à l'origine ou dans le coin. Un SCU par espace (objet, chaque présentation), annulable.
- Dans le SCU : coordonnées tapées (x,y, @dx,dy, d<a, @d<a ; préfixe `*` pour les coordonnées générales),
  coordonnées du curseur, ORTHO, POLAIRE, repérage, grille et pas, angle par défaut des textes et des blocs.
- Fichiers : SCU courant ($UCS…, $PUCS…, présentations), table UCS des SCU nommés, icône (VPORT) ; relus dans les
  DXF et DWG d'AutoCAD. Validé AutoCAD 2024 : AUDIT 0, SCU courant, icône et SCU nommés relus, `trans` cohérent.

## Ordre de tracé et masques

- **Ordre de tracé** comme AutoCAD : les objets sont dessinés dans l'ordre de création (le dernier au-dessus), un
  aplat posé après un trait le recouvre. **ORDRETRACE** (DRAWORDER, DR) : premier plan, arrière-plan, au-dessus ou
  au-dessous d'objets de référence ; **PREMIERPLAN**, **ARRIEREPLAN** ; **TEXTEPREMIERPLAN** (TEXTTOFRONT : textes,
  cotes, repères) ; **HACHURESARRIERE** (HATCHTOBACK). Une hachure est posée **derrière son contour** (comme
  HPDRAWORDER = 3). Annulable ; un nouvel objet reste au-dessus de tous. À l'écran, l'ordre est rendu par la
  carte graphique (profondeur) : aucun coût sur les gros dessins.
- **MASQUE** (WIPEOUT) : polygone point par point ou polyligne fermée (effacée ou non), de la couleur du fond
  (fond de l'écran, feuille blanche d'une présentation, papier au tracé) ; il cache ce qui est dessous dans l'ordre
  de tracé, textes compris. **MASQUE › Cadres** : activés, désactivés ou affichés sans être tracés (WIPEOUTFRAME).
  Poignées aux sommets ; désigné par son cadre.
- Fichiers : objets écrits dans l'ordre de tracé, table de tri (SORTENTSTABLE) quand il le faut, masques WIPEOUT
  et WIPEOUTFRAME comme AutoCAD ; relus dans les DXF et DWG d'AutoCAD (ordre, masques, cadres). Validé AutoCAD 2024 :
  AUDIT 0, ordre complet relu à l'identique (GetFullDrawOrder), masque et textes tracés comme à l'écran.
- Tracé PDF : par bandes successives, chaque masque recouvre de blanc ce qui a été tracé avant lui.
- Couleurs affichées exactes (les couleurs intermédiaires, gris 8, orange 30…, n'étaient pas éclaircies à tort).

## Hachures

- **HACHURES** ouvre la boîte des hachures : **galerie de motifs avec aperçus**, plein ou motif, échelle, angle,
  origine (0,0, coin du contour ou point désigné), contour par **point intérieur** ou par objets fermés, îlots
  détectés ou ignorés, **associative**, couleur de fond, calque. Puis on clique dans les zones (Entrée pour finir).
  Le contour est reconstruit à partir des lignes, arcs, cercles, polylignes et du contenu des blocs visibles ; les
  bouts pendants sont ignorés et les îlots (poteaux, gaines) deviennent des trous.
- **Motifs** : 12 motifs intégrés écrits pour l'appli (lignes, ANSI31, ANSI37, grille, carrelage, points, gravier,
  briques, acier, terre, **isolation en zigzag**, béton), les fichiers **.pat de l'utilisateur** lus sur place
  (acadiso.pat et acad.pat d'AutoCAD, motifs des bibliothèques installées…) et les fichiers .pat importés (« Importer .pat… »,
  gardés dans le navigateur). Échelle proposée selon l'échelle des annotations (acad.pat en pouces : × 25,4).
- **Associativité** : une hachure créée par point intérieur ou par objet suit son contour quand on déplace, étire ou
  modifie ces objets (dans la même étape d'annulation) ; si un objet du contour est effacé, la hachure garde sa forme
  et n'est plus associative.
- **Modifier** : HACHEDIT (même boîte), ou palette Propriétés : échelle, angle, couleur de fond, associativité ;
  aire affichée. Les hachures lues dans un fichier se modifient aussi (motif retrouvé depuis leurs lignes).
- **-HACHURES** : en ligne de commande (Plein, ANSI31, Croisillons, Grille, Lignes avec leur espacement, ou Autre :
  n'importe quel motif par son nom, échelle, angle).
- **DXF** : nom du motif, type (motif d'AutoCAD ou personnalisé), échelle, angle, lignes de définition, points
  intérieurs, **couleur de fond lue et écrite comme AutoCAD** (HATCHBACKGROUNDCOLOR) ; associativité gardée par
  l'appli. Contrôle : 12 motifs écrits par l'appli relus par AutoCAD 2024 (AUDIT 0) et tracés : traits identiques à
  ceux de l'appli à moins de 0,08 mm ; hachure faite dans AutoCAD (fond, îlots) relue à l'identique.

## Présentations (espace papier)

- **Onglets sous le dessin**, comme AutoCAD : `Objet | Présentation1 | … | +`. Double-clic pour renommer, clic
  droit pour Mise en page…, Renommer, Déplacer, Supprimer (annulable), Nouvelle présentation.
- **Feuille** : la présentation montre la feuille de sa mise en page (blanche sur fond gris, avec ombre), et la
  zone non imprimable en pointillés s'il y a des marges. Couleur 7 en noir, comme sur le papier.
- **Mise en page** (MISEENPAGE, ou clic droit sur l'onglet) : format A4 à A0, formats ajoutés (onglet Format →
  Formats) ou personnalisé, orientation, origine de la feuille, marges, noir ou couleurs, épaisseurs.
  Annulable, enregistrée dans le DXF (feuille et limites) ; une présentation d'un DWG prend la feuille de ses
  limites (formats sur mesure des bureaux reconnus tels quels).
- **PRESENTATION** crée une présentation avec sa mise en page et, comme AutoCAD, une fenêtre automatique
  (l'espace objet entier, à la plus grande échelle normalisée qui tient). **FMULT** (MVIEW) ajoute une fenêtre à
  l'échelle voulue (1:100…) ou ajustée. Les poignées de coin redimensionnent la fenêtre sans déplacer le contenu.
- **Fenêtres non rectangulaires** : FMULT › Polygonale (contour point par point) ou Objet (polyligne fermée, cercle,
  ellipse, qui devient le cadre) ; **DECOUPFENETRE** (VPCLIP) découpe une fenêtre existante ou la rend rectangulaire,
  sans changer son échelle ni sa vue. Contenu, textes et fonds découpés au contour à l'écran et au tracé ; DXF comme
  AutoCAD (polyligne de contour, code 340), fenêtres polygonales d'AutoCAD relues (DXF, DWG).
- **Fenêtres, réglages propres à chacune** (Propriétés de la fenêtre) :
  - échelle normalisée (liste 1:1 à 1:10 000) ou libre, affichage verrouillé, désactivée ;
  - transparence des hachures et remplissages ;
  - « Calques de la fenêtre… » : gel, couleur, épaisseur et transparence par calque, dans cette fenêtre seulement ;
  - double-clic dans une fenêtre pour l'activer : la molette zoome, le bouton du milieu déplace la vue (une
    étape d'annulation) ; Échap ou double-clic dehors pour revenir à la feuille.
- **ÉPAISSEUR** (barre d'état, LWDISPLAY) : épaisseurs de trait affichées dans les présentations, à leur taille
  réelle sur le papier (au moins un pixel), y compris celles imposées dans une fenêtre.
- Le contenu de l'espace objet s'affiche dans chaque **fenêtre de présentation**, à son échelle, avec sa
  torsion, découpé au cadre (géométrie construite une fois sur le GPU puis redessinée dans chaque fenêtre).
  Correspondance objet → papier vérifiée contre AutoCAD (`trans`) sur une fenêtre tournée de 335°.
- **TRACER** depuis une présentation : la feuille de la mise en page, au 1:1, découpée aux marges, avec le
  contenu des fenêtres et leurs réglages (couleurs, épaisseurs, transparences). **PUBLIER** : toutes les
  présentations dans un PDF, chacune sur sa feuille.
- **Enregistrement DXF** : toutes les présentations, avec leurs fenêtres et leur mise en page (validé dans
  AutoCAD : 0 erreur, feuille et contenu au même endroit au tracé). Le verrouillage des fenêtres est relu par
  AutoCAD ; les réglages de calques par fenêtre sont propres à l'appli (conservés dans le DXF pour elle).

## Réglages du dessin (onglet Format)

Onglet **Format** du ruban (REGLAGES, ou TYPELIGNE, EPAISSEUR, STYLEPOINT, STYLETEXTE, STYLECOTE, FORMATS,
PREFERENCES pour ouvrir directement le bon onglet) :

- **Unités** : unité du dessin, précision des longueurs et des angles (affichage), échelle des annotations.
- **Formats** : formats ISO et formats ajoutés (nom, largeur, hauteur), proposés dans la mise en page.
- **Lignes** : types de ligne du dessin (aperçu, suppression des inutilisés), chargement des types standard
  (CACHE, AXES, INTERROMPU, POINTILLE, MIXTE, FANTOME…), échelle globale ; couleur, type de ligne et épaisseur
  courants des nouveaux objets ; épaisseur « Défaut » ; affichage des épaisseurs.
- **Points** : style de point (20 styles, comme PDMODE) et taille (relative au papier ou absolue).
- **Textes** : hauteur par défaut (TEXTE, TEXTMULT, DEFATT), style courant des nouveaux textes, styles de texte
  du dessin (police SHX ou TrueType, facteur de largeur, oblique ; nouveau style, suppression d'un style inutilisé),
  dossier de polices SHX supplémentaire.
- **Cotes** : hauteur du texte, taille et type d'extrémités (flèche pleine, ouverte, trait oblique, point),
  lignes d'attache, écart, décimales, facteur des mesures (cotes en m d'un dessin en mm), suffixe ; aperçu.
- **Préférences** (cet ordinateur) : taille du réticule, de la boîte de sélection, des poignées, de la zone
  d'accrochage.

Les réglages du dessin sont annulables et enregistrés dans le DXF (variables d'AutoCAD : LUPREC, PDMODE,
CELTYPE, DIMTXT, DIMLFAC, DIMTSZ…, relues par AutoCAD).

## Polices SHX

Les textes des styles en police **SHX** (txt, simplex, romans, isocp…) sont **dessinés en traits, comme dans
AutoCAD**, à l'écran, dans les fenêtres de présentation et au tracé PDF. Les polices sont lues **là où elles sont** :
dossier Fonts d'AutoCAD, dossiers de support de l'utilisateur, ou dossier choisi (onglet Format › Textes) — rien
n'est copié dans l'appli. Lecteur des fichiers écrit pour l'appli : polices « shapes », Unicode et « big fonts »,
tous les codes de forme (vecteurs, arcs d'octants, arcs fractionnaires, arcs par renflement, sous-formes…), facteur
de largeur et oblique du style, symboles °, ±, Ø.

Contrôle sur AutoCAD 2024 : boîtes des textes identiques à TEXTBOX pour txt, simplex et romans ; traits comparés à
un PDF tracé par AutoCAD pour dix polices (txt, simplex, romans, isocp, gbenor, exthalf2, gothice, italic, complex,
romand) : écart inférieur à 0,8 % de la hauteur (précision du PDF). Les styles (police, largeur, oblique), le
style de chaque texte et le style courant sont écrits dans le DXF et relus par AutoCAD (AUDIT 0). Une police
TrueType, ou SHX introuvable, garde l'affichage en police de l'appli (Arial).

## Fluidité

- Un point est pris **à l'appui** du bouton, là où il a été pressé : des clics rapides ne sont jamais perdus,
  même si la souris bouge pendant l'appui (polylignes, lignes…).
- Clics et saisies arrivés pendant qu'une commande calcule sont mis en file et rejoués dans l'ordre.
- Poignées : glisser-déposer, ou cliquer la poignée puis la destination.
- L'aperçu d'une commande est redessiné dans l'image même du mouvement (aucun retard sur le curseur), sans
  redessiner les textes du dessin.

## Calques et propriétés

- **ATTENUER** (FADE) : fond de plan grisé — calques des xrefs ou calques choisis, atténuation en % — pour faire
  ressortir les réseaux (comme XREFFADE).
- **CALQUE** (LA) : gestionnaire des propriétés des calques — actif, gelé, verrouillé, couleur, type de ligne,
  épaisseur, impression ; chaque modification est annulable.
- **ETATCALQUE** (LAYERSTATE, LAS) : états de calques — enregistrer les propriétés de tous les calques sous un nom
  (avec le calque courant), les restaurer en choisissant les propriétés (activé, gelé, verrouillé, tracé, couleur,
  type et épaisseur de ligne…), option « désactiver les calques absents de l'état », mettre à jour, renommer,
  décrire, supprimer ; **importer** un fichier .las d'AutoCAD ou les états d'un autre dessin (DXF, DWG),
  **exporter** en .las. La liste « État » du panneau Calques restaure un état d'un clic et indique l'état
  identique aux calques actuels. **-ETATCALQUE** : mêmes opérations en ligne de commande. États gardés dans le
  DXF comme AutoCAD (ACAD_LAYERSTATES), relus dans les DXF et DWG d'AutoCAD ; .las identique à l'octet près à
  celui d'AutoCAD ; états de l'appli restaurés à l'identique par AutoCAD 2024 (AUDIT 0). Un calque renommé
  reste dans ses états.
- **Propriétés** : calque, couleur, **type de ligne** et **épaisseur** de chaque objet (ou d'une sélection).
- **RECHERCHER** (FIND) : chercher / remplacer dans les textes et les valeurs d'attributs (casse, mot entier,
  sélection), liste des résultats avec zoom ; remplacement en une seule étape d'annulation.

## Nettoyage des fonds de plan

- **PURGER** : supprime blocs (y compris imbriqués), calques et types de ligne inutilisés ; annulable.
- **SUPPRDOUBLONS** (OVERKILL) : objets en double (même géométrie, même calque / couleur / type de ligne,
  lignes inversées comprises) et lignes colinéaires qui se chevauchent (fusionnées). Les réseaux MEP ne sont
  jamais touchés. Sur le DWG lourd : 112 500 objets analysés en 0,2 s, 1 750 doublons retirés.
- **SELECTRAPIDE** (QSELECT) : sélection par type, calque, couleur et système MEP, avec le compte en direct.

## Fonds de plan (bases architecte)

Commande **FOND** (ruban Outils → Fonds de plan) : le gestionnaire des bases d'architecte utilisées en fond.

- **Attacher** une base DWG, DXF ou IFC, par le sélecteur de fichier ou par son **chemin**. Avec un chemin,
  le serveur local lit le fichier, et la base pourra être rechargée et ses nouvelles versions détectées.
- **Traitement** de la base avant insertion :
  - même nettoyeur et mêmes profils que le module AutoCAD LT (Express, Base architecte, Fond de plan gris) ;
  - les profils `.tpp` s'importent et s'exportent ;
  - table de calques CSV au même format que le module LT (TPTABLECALQUES / TPCALQUES).
- **Insertion** :
  - comme une xref (`nom|calque`), à l'échelle des unités du dessin (base en cm dans un dessin en mm : ×10) ;
  - sur le calque `FOND-<nom>`, verrouillé : le fond ne se sélectionne pas par mégarde, l'accrochage reste actif ;
  - atténuation réglable.
- **IFC** : on choisit le niveau et la hauteur de coupe. Le plan obtenu montre :
  - les murs, poteaux et menuiseries coupés, en traits épais ;
  - les dalles, escaliers, mobilier et sanitaires vus en dessous, en traits fins ;
  - les noms des locaux.
- **Nouvelle version** (Recharger, ou choisir un autre fichier) : même position, mêmes calques, même traitement.
  Les changements sont affichés :
  - ajouts en vert, suppressions en rouge ;
  - zones encadrées, avec une liste cliquable pour zoomer ;
  - nuages de révision possibles, sur le calque `FOND-MODIFICATIONS`.
- **Détection** : quand le fichier d'un fond change sur le disque, un bouton « Nouvelle version » apparaît dans
  la barre d'état.
- **Enregistrement** :
  - un fond dont on connaît le chemin est écrit comme une vraie référence externe (AutoCAD la charge) ;
  - les autres sont liés ;
  - à la réouverture, le fond est relu depuis son chemin et retraité.
- **Annulation** : attacher, remplacer et retirer s'annulent chacun en une étape.
- **Grosses bases** : la référence est indexée en grille. Sur 113 000 objets, l'accrochage prend 16 ms et la
  sélection 7 ms par mouvement de souris.

## Électricité (NIBT)

Onglet **Électricité** du ruban : plans d'installation électrique, calculs d'après la NIBT (SN 411000) — valeurs
indicatives, voir [Avertissement](#avertissement-calculs) — ; calques propres à l'application
(`ELE-<domaine>-APPAREILS`, `-TEXTES`, `-LEGENDE`, fils `ELE-FILS-NORMAL / SECOURS / ASI`), renommables.

- **Symboles** (SYMBOLE) :
  - 44 symboles intégrés (CEI 60617), classés par catégorie : lumière, commandes, éclairage de secours, prises et
    force, stores, tableaux, TT / informatique, TV, interphonie, détection incendie, sécurité, vidéo, accès,
    terre, courant faible divers ;
  - chaque catégorie a son calque d'appareils et son calque de textes, créés avec la couleur de la norme ;
  - pose avec rotation (R), rattachement au tableau et au circuit choisis (bouton « Nouveau » : prochain
    numéro libre), étiquettes CIRCUIT / INFO toujours lisibles à droite du symbole.
- **Bibliothèque DWG** (BIBLIOELEC, ou onglet « Bibliothèque DWG » de la palette) : les symboles d'une bibliothèque
  de blocs que vous possédez (palettes d'outils AutoCAD `.atc` et DWG des blocs), par exemple une bibliothèque
  électrique du commerce installée sur le poste. Aucune bibliothèque n'est fournie avec l'application.
  - On indique le dossier de la bibliothèque ; il est retenu.
  - Le serveur local lit les palettes (bloc, calque, échelle de chaque outil), l'appli lit le DWG des blocs, sur
    place (rien n'est copié dans l'application) ; aperçu de chaque bloc.
  - À la pose, le bloc est copié dans le dessin avec ses calques et ses types de ligne. L'appareil est posé sur
    le calque de l'outil, ses attributs sur le calque de textes correspondant.
  - Chaque outil reçoit un symbole intégré équivalent (reconnu d'après son nom et son calque) : prise triple,
    luminaire 2 × 36 W (72 W lus dans le nom), tableau, moteur… Il entre donc dans le bilan comme un symbole intégré.
  - Les blocs d'annotation (conduites, boîtes, flèches, étiquettes, percements, signalétique) sont posés tels
    quels, sans données électriques.
  - Attributs `CN_*` (convention de certaines bibliothèques du marché) remplis et tenus à jour : CN_LIB_SUP
    (circuit), CN_LIB_INF (puissance ou désignation), CN_TAB_NO (tableau), CN_DESIGN, CN_PUISSANCE ; les autres
    restent libres.
  - Échelle : blocs dessinés en cm pour le 1:50 (cas courant), convertis dans les unités du dessin et adaptés à
    son échelle des annotations ; un facteur permet de les agrandir ou de les réduire.
- **Tableaux** (TABLEAU) : TP puis TD1, TD2…, chacun alimenté par un tableau amont. Les puissances remontent vers
  l'origine, les chutes de tension se cumulent depuis le point de raccordement.
- **Circuits** (CIRCUIT) : rattache les appareils sélectionnés à un circuit (L1, P1, F1…), type déduit des
  appareils. Les étiquettes suivent.
- **Bilan NIBT** (BILANELEC), par tableau :
  - puissance installée, simultanéité (prises : ks = 0,1 + 0,9/n), courant d'emploi ;
  - protection, section, Iz (CEI 60364-5-52, facteurs de température et de groupement) ;
  - chute de tension cumulée (limite 4 %), longueur maximale protégée (schéma TN) ;
  - DDR 30 mA sur les circuits de prises ;
  - longueurs **par les chemins de câbles et les tubes dessinés** (repère CDC), sinon estimées sur le plan
    (trajets orthogonaux, repère est.) ;
  - chaque valeur s'impose dans le tableau ; export CSV.
- **Cheminement des câbles** : chaque appareil et chaque tableau est raccordé au chemin de câbles ou au tube le
  plus proche (dans une distance maximale), avec la descente jusqu'à sa hauteur de pose ; le câble suit le plus
  court chemin depuis le tableau par les chemins de câbles (coudes, piquages, prolongements, montées) et les tubes
  (un tube qui aboutit sur un chemin de câbles y est relié). Longueur du circuit = trajets vers ses appareils +
  raccordements, réserve de longueur (10 %) et réserve à chaque raccordement (0,5 m) comprises. Appareils hors de
  portée : estimés. **CHEMINEMENT** dessine les trajets (calque ELE-CHEMINEMENT, remplacés à chaque fois).
- **TUBE** : tube électrique souple (TUB-CFO / TUB-CFA), diamètre M16 à M40, pose comme la légende des plans : noyé
  plafond (dalle, trait continu), noyé au sol (tirets), noyé en mur, dans faux-plancher ou faux-plafond (trait mixte),
  dans chemin de câbles, apparent ; altitude ; changements de direction en courbes larges (20 × le diamètre, réduites si
  la place manque), sans pièce de coude ; étiquette « M20 noyé plafond », métré « Tube électrique ». Les tubes noyés
  (dalle, sol, mur) ne sont pas comptés dans les conflits MEP. **Un tube va d'un point A à un point B** : le
  cheminement ne l'emprunte qu'en entier, d'une extrémité à l'autre (posées sur une boîte, un appareil, un tableau, un
  autre tube ou un chemin de câbles) — jamais d'entrée au milieu d'un tube.
- **Dessin des réseaux en continu** (GAINE, CANALISATION, TUBE, CHEMINCABLE, « Dessiner … » du clic droit) : Entrée
  termine le tronçon et on enchaîne le suivant avec les mêmes réglages ; deux fois Entrée ou Échap terminent.
- **Alimentations** : réseau normal, secours, ASI — par tableau (bilan) et par circuit (colonne « Alim. ») ; l'éclairage
  de secours est en secours par défaut. **CHEMINEMENT** dessine les fils de chaque départ sur le calque de son
  alimentation (ELE-FILS-NORMAL, ELE-FILS-SECOURS, ELE-FILS-ASI : couleur du calque).
- **ETIQCIRCUIT** (« Étiqueter ») : étiquette sur n'importe quel objet — appareil (son circuit), tableau (son
  alimentation), boîte (circuits de ses tubes), tube ou chemin de câbles (circuits qui y passent), fil — une colonne par
  circuit (nom, câble), à la couleur de son alimentation, placée où l'on clique.
- **Boîtes et cheminement** (palette Symboles) : boîte de dérivation encastrée, murale, sur CDC (relie ses tubes au
  chemin de câbles qui la porte), boîte de sol équipée / non équipée, potelet, perche, montée, descente.
- **Courants de court-circuit** (méthode des impédances simplifiée, d'après la CEI 60909) : Ik3 max au jeu de
  barres de chaque tableau, comparé au pouvoir de coupure des disjoncteurs ; Ik1 min phase-neutre au bout de
  chaque départ, comparé au seuil de déclenchement instantané (B 5 In, C 10 In, D 20 In ; fusibles gG 5 In en
  valeur générale). Source déduite des Ik3 / Ik1 au point de raccordement (données électriques, 10 kA / 1 kA par
  défaut, X/R 10), câbles à 20 °C pour Ik max et chauds (1,5 ρ) pour Ik min, c max 1,1 / c min 0,95. Affichés dans
  le bilan (ligne du tableau, colonne Ik1 min), le CSV, la table et le schéma unifilaire.
- **Sélectivité** (règles générales) entre la protection d'arrivée d'un tableau et chacun de ses départs : rapport
  des calibres (disjoncteurs 2, fusible gG en amont 1,6 ; données électriques), puis seuil magnétique bas de
  l'amont (B 3 In, C 5 In, D 10 In) comparé à l'Ik3 max du jeu de barres : totale, partielle jusqu'à x kA, ou non
  assurée (alerte). Les calibres automatiques des départs vers les tableaux et de l'alimentation respectent le
  rapport (courbe C par défaut). Sélectivité garantie au-delà : tables du fabricant (plus tard).
- **Remplissage** (onglet « Chemins de câbles » du bilan) : câbles de chaque chemin (section utile largeur ×
  hauteur, 50 % max.) et conducteurs isolés de chaque tube (section intérieure, 33 % max.), diamètres
  approximatifs.
- **Données électriques** (onglet du bilan) : réseau (U0, Un, schéma, Ik3 / Ik1 au raccordement, chute de
  tension admise), câbles, matériels (fabricant, courbe, pouvoir de coupure, fusibles, DDR), cheminement
  (systèmes empruntés, distances, réserves, remplissages, hauteurs de pose par défaut). Valeurs générales par
  défaut, à préciser par projet ; enregistrées dans le dessin (DXF : XRECORD CV_DONNEES_ELEC).
- **Livrables** :
  - tableau du bilan (BILANTABLE) ;
  - schéma unifilaire d'un tableau ou de tous (UNIFILAIRE, option Tous) : **une présentation par page, prête à
    imprimer** — A4 paysage si le tableau tient sur une page (12 départs), sinon pages A3 paysage (18 départs) —,
    cadre et cartouche (projet, contenu, tableau, page n / N, date, établi par, indice), renvois du jeu de barres
    d'une page à l'autre ; Ik du jeu de barres et Ik1 de chaque départ ; présentations « Unifilaire <tableau> »
    refaites à chaque fois ;
  - légende des symboles utilisés, avec leur nombre (LEGENDEELEC) ; les blocs de bibliothèque y figurent avec
    leur nom.
- **Enregistrement** : données électriques et réglages des circuits conservés en DXF (XDATA). Validé dans AutoCAD
  2024 : AUDIT sans erreur, attributs relus, calques et couleurs SIA.
- Les résultats de dimensionnement sont des propositions, à vérifier par le projeteur.

## Coordination BIM (IFC, BCF)

- **EXPORTIFC** (ruban Fichier) : fichier IFC4 (ReferenceView) des réseaux et de l'électricité, en millimètres :
  gaines (IfcDuctSegment / IfcDuctFitting), canalisations (IfcPipeSegment), chemins de câbles et tubes
  (IfcCableCarrierSegment, tube = CONDUITSEGMENT ; IfcCableCarrierFitting), bouches (IfcAirTerminal), appareils
  électriques (IfcLightFixture, IfcOutlet, IfcSwitchingDevice, IfcElectricDistributionBoard, IfcElectricAppliance).
  Géométrie : section extrudée le long de chaque tronçon, coudes à rayon en morceaux de 10°, boîtes pour les
  appareils (à leur hauteur de pose). Systèmes (IfcDistributionSystem, type selon le système) et circuits
  (IfcDistributionCircuit « TP.L1 »). Jeu de propriétés **CV_Parametres** : système, section, numéro de circuit (pour un
  chemin de câbles : circuits qui y passent), numéro de tableau, puissance, intensité, tension — liste extensible
  (`IFC_PROPERTIES` dans `src/io/ifc-writer.js`). GlobalId stables d'un export à l'autre. Prévu pour Revit 2025.
- **BCF 2.1** : bouton « Exporter BCF » des INTERFERENCES (.bcfzip, un sujet par conflit : titre, description,
  statut, commentaire, point de vue en perspective sur le conflit avec les éléments IFC désignés par leur GlobalId,
  capture du plan) ; **OUVRIRBCF** relit un .bcfzip de l'appli ou d'un autre logiciel (sujets, statuts,
  commentaires) et zoome sur les objets désignés.

## Module AutoCAD LT : Traitement de plans

Le dossier `autocad-lt/` contient `TraitementPlans.lsp`, un nettoyeur de plans pour **AutoCAD LT 2024+**
(et AutoCAD), écrit en AutoLISP + DCL :
profils enregistrables, conversion de calques par table CSV, décomposition des blocs imbriqués,
traitement par lot. Installation et utilisation : [`autocad-lt/Lisez-moi.md`](autocad-lt/Lisez-moi.md).

## Performances (banc d'essai, 330 000 objets / 3 M de segments)

- Construction de la vue ≈ 1,4 s ; sélection ≈ 0,01 ms ; déplacer 1 objet ≈ 3 ms, 1 000 objets ≈ 25 ms ;
  masquer un calque < 1 ms.
- Vrai DWG lourd (116 500 objets, 2,7 M segments, 10 300 textes) : ouverture ≈ 3,8 s (lecture 2,4 s, import
  0,15 s, vue 1,2 s), puis panoramique / zoom / sélection instantanés. Les DWG de plus de 1,5 Mo sont
  convertis **en parallèle par 2 à 4 workers** (chacun convertit une entité sur N, puis on réunit en
  gardant l'ordre exact) ; les workers sont préchauffés au démarrage. Lecture seule : 4,1 s → 2,1 s.
- Opérations massives sur ces 113 000 objets : tout sélectionner 0,4 s, tout déplacer 0,9 s, annuler 0,8 s,
  tout effacer 0,3 s ; SUPPRDOUBLONS 0,2 s.
- Géométrie des blocs calculée une seule fois par définition ; rendu par paquets (une modification ne
  reconstruit qu'un paquet) ; index spatial R-tree.

## Limites connues

- Écriture DWG uniquement via un AutoCAD installé sur le même PC (sinon DXF).
- Champs : formats d'AutoCAD courants (nom de fichier %fn…, dates Windows, nombres %lu2 %pr %ct %ps %ds) ; les
  propriétés du dessin (auteur, titre…) et les champs de jeu de feuilles ne sont pas gérés.
- SCU : en 2D seulement (pas d'axes X / Y inclinés en 3D, pas de vue tournée sur le SCU comme PLAN) ; les angles
  tapés pour une rotation (ROTATION…) restent des écarts, ceux d'orientation (texte, bloc) suivent le SCU.
- Ordre de tracé : les textes TrueType restent au-dessus des aplats (seuls les masques les cachent) ; avec l'affichage
  des épaisseurs dans une présentation (LWDISPLAY), les traits épais passent au-dessus ; dans une fenêtre, les textes
  de l'espace objet ne sont pas cachés par les masques à l'écran (ils le sont au tracé). Cadres « affichés non
  tracés » : AutoCAD les relit « désactivés » (le DXF de l'appli est au format 2007).
- Fenêtres de présentation : le gel de calques par fenêtre (VPCALQUE, Propriétés) est géré, tracé et relu en DXF
  (validé AutoCAD), mais LibreDWG ne le fournit pas pour les DWG. Fenêtres non rectangulaires : une transformation
  autre qu'un déplacement (rotation, échelle) déplace le contour mais garde l'échelle de la vue.
- Fonds joints : images TIFF non lues par le navigateur (à convertir en PNG) ; un PDF importé (PDFIMPORT) garde
  ses textes en police de l'appli ; le réglage d'affichage du cadre (PDFFRAME) n'est pas enregistré.
- Non gérés : OLE, objets proxy (AutoCAD Architecture/MEP), solides 3D ACIS. Les MULTILEADER et
  LEADER sont lus (lignes, flèches, palier, texte identiques à l'explosion d'AutoCAD) mais deviennent des blocs.
- Groupes (GROUPE) : un clic sélectionne le groupe entier ; conservés en DXF (validé AutoCAD), non lus dans les DWG
  (LibreDWG ne fournit pas les objets GROUP).
- Polylignes épaisses (largeur constante ou variable par segment, flèches) dessinées pleines à l'écran et au
  tracé, conservées en DXF (validé AutoCAD).
- Polices TrueType des styles affichées en Arial ; codes de mise en forme des MTEXT (\\f, \\H…) ignorés (police du
  style). Pas de saisie tactile à deux doigts.
- CHANFREIN : lignes et segments droits seulement (AutoCAD ne chanfreine pas les arcs non plus). RACCORD gère lignes,
  arcs, cercles et segments courbes des polylignes ; l'option Polyligne (toute la polyligne) ne traite que les coins droits.
- Cotes associatives dans l'application ; à l'enregistrement DXF elles deviennent de simples blocs (non associatives dans AutoCAD).
- Bibliothèque DWG : les blocs dynamiques sont copiés dans leur état par défaut, sans leurs paramètres
  (étirement, visibilité). Dans un dessin enregistré par l'appli, un bloc de bibliothèque est donc un bloc simple.

## Organisation du code

| Dossier / fichier | Rôle |
|---|---|
| `src/core/` | Modèle : `geom` (géométrie), `document` (calques, blocs, annuler/rétablir), `entities` (transformations, poignées, accrochages), `path` (ajuster, prolonger, décaler, raccord, coupure, étirer), `tessellate` (géométrie affichable, cache des blocs, types de ligne), `dimension` |
| `src/io/` | `read.js` + `read-worker.js` (lecture), `importer.js` (fichier → document), `dxf-writer.js`, `ifc-writer.js` (export IFC4), `bcf.js` (BCF 2.1), `zip.js` |
| `src/render/renderer.js` | Rendu three.js par paquets, R-tree, sélection, vue 3D |
| `src/editor/` | `editor.js` (souris, clavier, requêtes des commandes), `commands.js`, `dims.js`, `snap.js`, `parse.js` |
| `src/mep/` | `systems.js` (systèmes, sections, pentes), `geometry.js` (dessin des réseaux), `commands.js`, `network.js` (débits, dimensionnement, pertes de charge, pentes), `connectivity.js` (raccordements maintenus), `supports.js`, `accessories.js`, `fabrication.js` (repères, nomenclature, pièces de forme), `section.js`, `reservations.js`, `clash.js`, `mep3d.js`, `table.js`, `repair.js` |
| `src/archi/` | Fonds de plan : `fonds.js` (attacher, remplacer, retirer, comparer), `clean.js` (traitement), `profiles.js` (profils .tpp), `layertable.js` (table de calques CSV), `compare.js`, `ifc.js` (IFC → plan), `sources.js` (fichier ou chemin), `commands.js` (FOND) |
| `src/elec/` | Électricité : `nibt.js` (calculs NIBT), `symbols.js` (symboles, calques, attributs), `library.js` (bibliothèque DWG / palettes d'outils), `circuits.js` (tableaux, circuits, bilan), `routing.js` (cheminement des câbles, remplissage), `shortcircuit.js`, `selectivity.js`, `settings.js` (données électriques), `schema.js` (unifilaire multipage, légende), `commands.js` |
| `src/blocks/acad-dynamic.js` | Blocs dynamiques d'AutoCAD : lecture (DXF, DWG via read.js), conversion des paramètres et actions, valeurs des insertions, comparaison avec la représentation d'AutoCAD, nom effectif |
| `src/blocks/acad-eval.js` | Évaluation des blocs d'AutoCAD : actions qui transforment aussi les paramètres, poignées, texte inversé lisible |
| `src/core/dimassoc.js` | Cotes associatives d'AutoCAD : références d'accrochage appli ↔ DIMASSOC, lecture des DXF, points de définition des cotes |
| `src/core/fields.js`, `src/editor/field-commands.js` | Champs : codes d'AutoCAD, évaluation, formats, lecture DXF / DWG ; CHAMP, MAJCHAMP |
| `src/core/ucs.js`, `src/editor/ucs.js` | SCU : conversions, SCU courant par espace ; commandes SCU, SCUICONE |
| `src/core/draworder.js`, `src/editor/wipeout.js` | Ordre de tracé (clés, premier plan, arrière-plan…) ; MASQUE, ORDRETRACE et raccourcis |
| `src/blocks/extract.js`, `src/blocks/extract-dialog.js` | Extraction des attributs : collecte, regroupement, CSV ; boîte EXTRACTATT, tableau et MAJEXTRACTION |
| `src/core/layerstates.js`, `src/ui/layerstates.js` | États de calques : capture, restauration, .las et DXF ; gestionnaire ETATCALQUE |
| `src/core/clip.js`, `src/io/xclip.js`, `src/editor/xclip.js` | Découpes : géométrie découpée par un polygone ; XCLIP dans les fichiers ; DECOUPXREF et DECOUPFENETRE |
| `src/hatch/` | Hachures : `patterns.js` (fichiers .pat, motifs intégrés, lignes du motif), `commands.js` (HACHURES, HACHEDIT, associativité), `dialog.js` (galerie) |
| `src/fonts/` | Polices SHX : `shx.js` (lecture des fichiers, codes de forme, traits d'une ligne de texte), `registry.js` (polices lues par le serveur, police d'un style) |
| `src/underlay/` | Fonds PDF et images : `underlay.js` (objet, repère de la page), `sources.js` (fichiers), `pdfjs.js`, `raster.js` (rendu, réglages), `layer3d.js` (affichage net au zoom), `vectors.js` (traits et textes du PDF, accrochage), `import.js` (PDFIMPORT), `plot.js`, `commands.js`, `dialog.js` |
| `src/plot/` | Tracé : `styles.js` (tables CTB, fichiers .ctb d'AutoCAD), `dialog.js` (boîte TRACER, aperçu), `ctb-editor.js` |
| `src/blocks/` | Blocs : `dynamic.js` (paramètres, actions, évaluation, poignées), `block-editor.js` (éditeur de blocs), `commands.js`, `insert-dialog.js` (INSERER), `preview.js` (aperçus), `ui.js` (barre, états, paramètres) |
| `src/layout/` | Présentations : `sheet.js` (mise en page, formats, échelles), `ui.js` (onglets, dialogue de mise en page), `vplayers.js` (calques par fenêtre) |
| `src/ui/` | Ruban, panneaux Calques, Références (`xrefs.js`) et Propriétés, réglages du dessin (`settings.js`) |
| `tests/` | Banc de tests navigateur, banc d'essai de performance |
| `autocad-lt/` | Module AutoCAD LT « Traitement de plans » : sources (`src/`), assemblage (`build.py`), tests AutoCAD (`tests/`) |

## Diffusion

- `python -I scripts/release.py [version]` : copie l'application dans `dist/CAD-Viewer-<version>/` et en fait une
  archive ZIP (sans `samples/`, `out/`, `tests/`, `docs/`) ; lancer ensuite `Lancer CAD Viewer.bat` dans ce dossier.
- Version Windows installable : `scripts/build_exe.py` puis `scripts/build_installer.py` ; les licences des
  composants embarqués (Python, PyInstaller, Tcl/Tk…) sont jointes dans le dossier `licenses/` de l'application.
- Composants tiers, licences et sources correspondantes : [`THIRD-PARTY.md`](THIRD-PARTY.md).
- Dessins d'exemple : seuls `samples/Démo MEP.*` et `samples/test-minimal.*` (créés pour le projet) sont publiés.
  Quelques tests utilisent en plus les dessins d'exemple livrés avec AutoCAD s'ils sont copiés dans `samples/` ;
  absents, ces tests sont ignorés.

## Licence

CAD Viewer — Copyright © 2026 JujuH et contributeurs.

Ce programme est un logiciel libre : vous pouvez le redistribuer et le modifier selon les termes de la **Licence
publique générale GNU, version 3 ou (à votre choix) toute version ultérieure** (GPL-3.0-or-later), publiée par la
Free Software Foundation. Il est distribué dans l'espoir qu'il sera utile, mais **SANS AUCUNE GARANTIE**, sans même
la garantie implicite de qualité marchande ou d'adéquation à un usage particulier. Texte complet : [`LICENSE`](LICENSE).

L'application intègre des bibliothèques sous leurs propres licences, toutes compatibles avec la GPL-3.0 (détail
dans [`THIRD-PARTY.md`](THIRD-PARTY.md)). LibreDWG (via `@mlightcad/libredwg-web`) et `@mlightcad/dxf-json` sont sous
GPL-3.0 : l'application distribuée dans son ensemble l'est donc aussi.

## Avertissement (calculs)

Les calculs (bilan de puissance, sections, chutes de tension, courants de court-circuit, sélectivité, débits,
pertes de charge, dimensionnement, remplissage des chemins de câbles et des tubes…) sont **indicatifs**. Ils
s'appuient sur des valeurs générales (cuivre / PVC, tableaux de la CEI 60364-5-52, formules usuelles) et ne
remplacent ni les normes en vigueur (NIBT, SIA, normes de produits), ni les données des fabricants, ni la
vérification par un professionnel qualifié. Les auteurs n'assument aucune responsabilité pour leur utilisation.

## Marques et indépendance

CAD Viewer est un projet indépendant. Il n'est ni affilié à, ni approuvé, ni soutenu par Autodesk, GITCAD Sàrl
(CADnorm), OBO Bettermann, Lanz Oensingen, Electrosuisse, buildingSMART ou tout autre éditeur ou fabricant cité.
AutoCAD, AutoCAD LT, DWG, TrustedDWG, Revit et Navisworks sont des marques d'Autodesk, Inc. ; CADnorm est une marque
de son titulaire ; les autres noms sont des marques de leurs propriétaires respectifs. Ils sont cités uniquement pour
décrire la compatibilité des fichiers et des usages.

## Interopérabilité et formats

- Les formats DWG, DXF, CTB/STB, SHX, .las, .pat, .atc et les données des blocs dynamiques, cotes associatives, champs
  et découpes sont lus et écrits pour permettre l'échange de fichiers. Leur structure a été établie à partir des
  documentations publiques (référence DXF), de bibliothèques libres (LibreDWG) et de l'observation de fichiers créés
  à cet effet ; aucun code d'un logiciel propriétaire n'a été décompilé ni repris.
- Aucun fichier d'un tiers n'est fourni : polices SHX, motifs de hachures (.pat), tables de tracé (.ctb, .stb),
  bibliothèques de blocs et gabarits sont lus sur place, sur le poste de l'utilisateur qui en détient la licence.
- La commande ENREGDWG fait enregistrer le DWG par une installation locale d'AutoCAD (accoreconsole), si
  l'utilisateur en a une ; il lui appartient de vérifier que sa licence le permet.

## Confidentialité et sécurité

- Aucune donnée n'est envoyée sur Internet : pas de télémétrie, bibliothèques servies localement (`vendor/`).
- Les dessins enregistrés contiennent, comme dans tout logiciel de DAO, les chemins des références externes et des
  fonds de plan (chemins locaux) : à garder en tête avant de partager un fichier.
- Le serveur local (`serve.py`, version installable) n'écoute que sur 127.0.0.1 et ne doit jamais être exposé sur un
  réseau. Il refuse les requêtes venant d'autres sites (en-têtes Host, Origin, Sec-Fetch-Site), mais ses routes
  `/__*` lisent des fichiers du poste (dessins, polices, motifs, palettes) : signaler toute faille de sécurité en
  privé aux mainteneurs plutôt que dans un ticket public.
