;; SPDX-License-Identifier: GPL-3.0-or-later
;;; ==========================================================================
;;; Traitement de plans 1.0 — nettoyage et normalisation de plans
;;; Pour AutoCAD LT 2024 et suivants, et AutoCAD : AutoLISP + DCL uniquement
;;; (ni ActiveX, ni .NET, ni Express Tools).
;;;
;;; Commandes :
;;;   TP              boîte de dialogue « Nettoyeur de plan » (profils enregistrables)
;;;   TPEXPRESS       nettoyage rapide avec le profil « Express », sans dialogue
;;;   TPPROFIL        lance un profil nommé (ligne de commande, scripts)
;;;   TPLOT           traitement par lot de tous les dessins d'un dossier
;;;   TPCALQUES       convertit les calques d'après une table CSV
;;;   TPTABLECALQUES  crée la table CSV des calques du dessin, à compléter dans Excel
;;;   TPPURGE         purge complète (éléments imbriqués) et contrôle
;;;   TPLIBERER, TPAPLATIR, TPORIGINE, TPNEXPL : opérations isolées
;;;   TPDOSSIER       dossier des profils (par exemple un dossier partagé)
;;;   TPAIDE          aide
;;;
;;; Fichier généré par build.py à partir de src/ : modifier les sources, pas ce fichier.
;;; ==========================================================================

(setq tp:*version* "1.0")

;;; --------------------------------------------------------------------------
;;; Outils généraux
;;; --------------------------------------------------------------------------

(defun tp:dxf (c d) (cdr (assoc c d)))

;; Remplace (ou ajoute, avant les données étendues) le groupe c.
(defun tp:put (c v d / p x)
  (cond ((setq p (assoc c d)) (subst (cons c v) p d))
        ((setq x (assoc -3 d)) (append (vl-remove x d) (list (cons c v) x)))
        (T (append d (list (cons c v))))))

(defun tp:drop (codes d) (vl-remove-if '(lambda (p) (member (car p) codes)) d))

(setq tp:*ws* (strcat " \t\r\n" (chr 160)))
(defun tp:trim (s) (vl-string-trim tp:*ws* s))

;; Termine la commande en cours (réponses par défaut, puis annulation si elle insiste).
(defun tp:end-cmd (/ n)
  (setq n 0)
  (while (and (> (logand 1 (getvar "CMDACTIVE")) 0) (< n 8)) (command "") (setq n (1+ n)))
  (if (> (logand 1 (getvar "CMDACTIVE")) 0) (command)))

;; Échappe les caractères spéciaux de wcmatch / ssget.
(defun tp:wc-escape (s / out c)
  (setq out "")
  (foreach c (vl-string->list s)
    (setq out (strcat out (if (member c '(35 64 46 42 63 126 91 93 45 96 44)) "`" "") (chr c))))
  out)

(defun tp:split (s sep / out p)
  (while (setq p (vl-string-search sep s))
    (setq out (cons (substr s 1 p) out) s (substr s (+ p 1 (strlen sep)))))
  (reverse (cons s out)))

(defun tp:replace-all (new old s / p)
  (while (setq p (vl-string-search old s))
    (setq s (strcat (substr s 1 p) new (substr s (+ p 1 (strlen old))))))
  s)

(defun tp:num (s / v)
  (if (and s (/= "" (setq s (tp:trim (tp:replace-all "." "," s)))))
    (if (numberp (setq v (vl-catch-all-apply 'read (list s)))) v)))

(defun tp:file-found (path / pre)
  (setq pre (getvar "DWGPREFIX"))
  (and path (/= path "")
       (or (findfile path)
           (findfile (strcat pre path))
           (findfile (strcat pre (vl-filename-base path) (vl-filename-extension path))))))

;;; --------------------------------------------------------------------------
;;; Réglages : liste associative (clé . valeur)
;;; --------------------------------------------------------------------------

;; Opérations (cases à cocher) ; les autres clés sont des paramètres.
(setq tp:*ops*
  '("LIBERER" "UNITES" "ORIGINE" "APLATIR"
    "PRESENTATIONS" "TEXTES" "PETITS" "MASQUES" "HACH_SOLIDES" "SOLIDES2D" "PROXY"
    "XREFS" "GROUPES" "BLOCS_VIDES" "CALQUES_SUPPR" "CALQUES_CACHES"
    "DUCALQUE" "DUBLOC" "COTES_DUBLOC" "TL_DUCALQUE" "EP_DUCALQUE" "COULEURS" "COULEUR_UNIQUE"
    "TYPESLIGNE" "STYLES" "MTEXT" "COTES_CALQUE" "HACH_CALQUE" "HACH_ARRIERE" "VERR_ARRIERE"
    "NEXPL" "CONV_CALQUES" "PURGE" "ECHELLES" "AUDIT"))

(defun tp:defaults ()
  (list
    '("LIBERER") '("UNITES") '("UNITE" . 4) '("PREC" . 2) '("CONVUNITE") '("UNITE_SRC" . 0)
    '("ORIGINE") '("ORIG_MODE" . "POINT") '("ORIG_PT" 0.0 0.0 0.0)
    '("APLATIR" . T)
    '("PRESENTATIONS") '("TEXTES" . T) '("PETITS" . T) '("TOL" . 0.0)
    '("MASQUES") '("HACH_SOLIDES") '("SOLIDES2D") '("PROXY" . T)
    '("XREFS" . T) '("XREF_MODE" . "INTROUVABLES") '("IMAGE_MODE" . "INTROUVABLES")
    '("GROUPES" . T) '("BLOCS_VIDES" . T) '("CALQUES_SUPPR") '("CALQUES_FILTRE") '("CALQUES_CACHES")
    '("DUCALQUE") '("DUBLOC") '("COTES_DUBLOC") '("TL_DUCALQUE") '("EP_DUCALQUE")
    '("COULEURS") '("COUL_TABLE") '("COUL_CALQUES" . T) '("COUL_FORCEES" . T) '("COUL_DUCALQUE")
    '("COULEUR_UNIQUE") '("COUL_UNIQUE" . 8) '("CU_CALQUES" . T) '("CU_ENTITES")
    '("TYPESLIGNE") '("TL_TABLE") '("TL_ECHELLE1") '("FICHIER_LIN" . "acadiso.lin")
    '("STYLES") '("STYLE_NOM" . "Standard") '("POLICE" . "")
    '("MTEXT")
    '("COTES_CALQUE") '("NOM_COTES" . "COTES") '("HACH_CALQUE") '("NOM_HACH" . "HACHURES")
    '("HACH_ARRIERE") '("VERR_ARRIERE") '("NEXPL")
    '("CONV_CALQUES") '("TABLE_CALQUES" . "")
    '("PURGE" . T) '("ECHELLES") '("AUDIT" . T)
    '("VERROUILLES" . T) '("GELES" . T) '("DESACTIVES" . T)))

(defun tp:cfg (k) (cdr (assoc k tp:*cfg*)))

;; Réglages du traitement copiés dans des variables tp:o-CLÉ (accès rapide dans les boucles).
(defun tp:set-flags (cfg)
  (foreach p (tp:merge-defaults cfg) (set (read (strcat "tp:o-" (car p))) (cdr p))))
(defun tp:cfg-of (cfg k) (cdr (assoc k cfg)))
(defun tp:cfg-set (cfg k v / p)
  (if (setq p (assoc k cfg)) (subst (cons k v) p cfg) (append cfg (list (cons k v)))))

;; Complète un profil lu avec les valeurs par défaut des clés absentes.
(defun tp:merge-defaults (cfg / out)
  (setq out (tp:defaults))
  (if (listp cfg)
    (foreach p cfg (if (and (listp p) (= 'STR (type (car p)))) (setq out (tp:cfg-set out (car p) (cdr p))))))
  out)

;;; --------------------------------------------------------------------------
;;; Profils : un fichier texte par profil (*.tpp) dans le dossier des profils
;;; --------------------------------------------------------------------------

(defun tp:dir (/ d)
  (setq d (getenv "TraitementPlans_Dossier"))
  (if (or (null d) (= d "")) (strcat (getenv "APPDATA") "\\TraitementPlans") d))

(defun tp:profile-file (name) (strcat (tp:dir) "\\" name ".tpp"))

(defun tp:profile-names (/ l)
  (setq l (vl-directory-files (tp:dir) "*.tpp" 1))
  (acad_strlsort (mapcar 'vl-filename-base l)))

(defun tp:profile-write (name cfg / f)
  (vl-mkdir (tp:dir))
  (if (setq f (open (tp:profile-file name) "w" "utf8"))
    (progn
      (write-line ";; Profil « Traitement de plans » : modifiable par la commande TP" f)
      (write-line "(" f)
      (foreach p cfg (write-line (strcat " " (vl-prin1-to-string p)) f))
      (write-line ")" f)
      (close f)
      T)))

(defun tp:profile-read (name / f l s r)
  (if (and (findfile (tp:profile-file name)) (setq f (open (tp:profile-file name) "r" "utf8")))
    (progn
      (setq s "")
      (while (setq l (read-line f))
        (setq l (vl-string-left-trim (strcat tp:*ws* (chr 65279)) l))
        (if (/= ";" (substr l 1 1)) (setq s (strcat s " " l))))
      (close f)
      (setq r (vl-catch-all-apply 'read (list s)))
      (if (and r (listp r) (not (vl-catch-all-error-p r))) (tp:merge-defaults r)))))

;; Profil lu, ou réglages par défaut s'il n'existe pas.
(defun tp:profile-load (name) (cond ((tp:profile-read name)) ((tp:defaults))))

(defun tp:builtin-profiles (/ express archi gris)
  (setq express (tp:defaults))
  (setq archi express)
  ;; Base architecte : prête à servir de fond de plan, couleurs de l'architecte conservées
  (foreach k '("PRESENTATIONS" "MASQUES" "HACH_SOLIDES" "MTEXT" "HACH_ARRIERE")
    (setq archi (tp:cfg-set archi k T)))
  (setq archi (tp:cfg-set archi "XREF_MODE" "NONREF"))
  ;; Fond de plan gris : tout en couleur 8 (calques), objets DuCalque, composants DuBloc
  (setq gris archi)
  (foreach k '("COULEUR_UNIQUE" "DUCALQUE" "DUBLOC" "COTES_DUBLOC" "EP_DUCALQUE")
    (setq gris (tp:cfg-set gris k T)))
  (list (cons "Express" express) (cons "Base architecte" archi) (cons "Fond de plan gris" gris)))

;; Crée les profils fournis s'ils manquent (premier lancement).
(defun tp:ensure-profiles ()
  (vl-mkdir (tp:dir))
  (foreach p (tp:builtin-profiles)
    (if (not (findfile (tp:profile-file (car p)))) (tp:profile-write (car p) (cdr p)))))

(defun tp:last-profile (/ n)
  (setq n (getenv "TraitementPlans_Dernier"))
  (if (and n (findfile (tp:profile-file n))) n "Express"))

;;; --------------------------------------------------------------------------
;;; Rapport
;;; --------------------------------------------------------------------------

(defun tp:note (label n / p)
  (if (and n (/= n 0))
    (if (setq p (assoc label tp:*rep*))
      (setq tp:*rep* (subst (cons label (+ (cdr p) n)) p tp:*rep*))
      (setq tp:*rep* (append tp:*rep* (list (cons label n)))))))

(defun tp:warn (s) (if (not (member s tp:*msgs*)) (setq tp:*msgs* (append tp:*msgs* (list s)))))

(defun tp:report-lines (secs / out)
  (setq out (list (strcat "Traitement de plans : terminé en " (rtos secs 2 1) " s")))
  (foreach p tp:*rep* (setq out (cons (strcat "  " (car p) " : " (itoa (cdr p))) out)))
  (if (null tp:*rep*) (setq out (cons "  Rien à modifier." out)))
  (foreach m tp:*msgs* (setq out (cons (strcat "  ! " m) out)))
  (reverse out))

;;; --------------------------------------------------------------------------
;;; Calques
;;; --------------------------------------------------------------------------

;; Liste des calques : (nom drapeaux couleur).
(defun tp:layer-list (/ d r)
  (setq d (tblnext "LAYER" T))
  (while d
    (setq r (cons (list (tp:dxf 2 d) (tp:dxf 70 d) (tp:dxf 62 d)) r) d (tblnext "LAYER")))
  (reverse r))

(defun tp:layer-set (name flags color / e d)
  (if (setq e (tblobjname "LAYER" name))
    (progn
      (setq d (entget e) d (tp:put 70 flags d))
      (if color (setq d (tp:put 62 color d)))
      (entmod d))))

;; Dégèle, active et déverrouille tous les calques ; le calque 0 devient courant.
(defun tp:layers-free (/ n)
  (setq n 0)
  (foreach l (tp:layer-list)
    (if (or (/= 0 (logand (cadr l) 5)) (< (caddr l) 0))
      (progn (tp:layer-set (car l) (logand (cadr l) (~ 5)) (abs (caddr l))) (setq n (1+ n)))))
  (setvar "CLAYER" "0")
  n)

;; Rétablit gel, verrouillage et activation (la couleur reste celle du traitement).
(defun tp:layers-restore (saved / e c)
  (foreach l saved
    (if (setq e (tblobjname "LAYER" (car l)))
      (progn
        (setq c (abs (tp:dxf 62 (entget e))))
        (tp:layer-set (car l) (cadr l) (if (< (caddr l) 0) (- c) c))))))

;; Calques dont les objets ne sont pas traités (verrouillés, gelés ou désactivés selon les options).
(defun tp:skip-layers (saved / r)
  (foreach l saved
    (if (or (and (/= 0 (logand (cadr l) 4)) (not tp:o-VERROUILLES))
            (and (/= 0 (logand (cadr l) 1)) (not tp:o-GELES))
            (and (< (caddr l) 0) (not tp:o-DESACTIVES)))
      (setq r (cons (strcase (car l)) r))))
  r)

;; Calques gelés ou désactivés (sauf 0 et DEFPOINTS).
(defun tp:hidden-layers (saved / r)
  (foreach l saved
    (if (and (or (/= 0 (logand (cadr l) 1)) (< (caddr l) 0))
             (not (member (strcase (car l)) '("0" "DEFPOINTS"))))
      (setq r (cons (strcase (car l)) r))))
  r)

(defun tp:layer-color (name / d)
  (if (setq d (tblsearch "LAYER" name)) (abs (tp:dxf 62 d)) 7))

;; Charge un type de ligne s'il manque ; renvoie son nom ou nil.
(defun tp:ensure-ltype (lt / file)
  (cond
    ((or (null lt) (= lt "")) nil)
    ((member (strcase lt) '("BYLAYER" "BYBLOCK" "CONTINUOUS")) lt)
    ((tblsearch "LTYPE" lt) lt)
    (T
     (foreach file (list tp:o-FICHIER_LIN "acadiso.lin" "acad.lin")
       (if (and file (/= file "") (findfile file) (not (tblsearch "LTYPE" lt)))
         (progn (command "_.-LINETYPE" "_L" lt (findfile file)) (tp:end-cmd))))
     (if (tblsearch "LTYPE" lt) lt))))

;; Crée le calque s'il manque, puis applique les propriétés données (nil = inchangée).
(defun tp:ensure-layer (name color lt lw / e d)
  (setq lt (tp:ensure-ltype lt))
  (if (setq e (tblobjname "LAYER" name))
    (if (or color lt lw)
      (progn
        (setq d (entget e))
        (if color (setq d (tp:put 62 (if (< (tp:dxf 62 d) 0) (- color) color) (tp:drop '(420 430) d))))
        (if lt (setq d (tp:put 6 lt d)))
        (if lw (setq d (tp:put 370 lw d)))
        (entmod d)))
    (entmake
      (append
        (list '(0 . "LAYER") '(100 . "AcDbSymbolTableRecord") '(100 . "AcDbLayerTableRecord")
              (cons 2 name) '(70 . 0) (cons 62 (if color color 7)) (cons 6 (if lt lt "Continuous")))
        (if lw (list (cons 370 lw)))))))

;;; Table de conversion des calques (CSV : source;cible;couleur;type de ligne;épaisseur)

(defun tp:csv-split (line sep / out cur q c l)
  (setq out nil cur "" q nil l (vl-string->list line))
  (while l
    (setq c (car l) l (cdr l))
    (cond
      ((and q (= c 34) (= (car l) 34)) (setq cur (strcat cur "\"") l (cdr l)))
      ((= c 34) (setq q (not q)))
      ((and (not q) (= c (ascii sep))) (setq out (cons cur out) cur ""))
      (T (setq cur (strcat cur (chr c))))))
  (reverse (cons cur out)))

(defun tp:read-lines (path enc / f l out)
  (if (setq f (if enc (open path "r" enc) (open path "r")))
    (progn
      (while (setq l (read-line f)) (setq out (cons l out)))
      (close f)
      (reverse out))))

;; Lit un CSV (UTF-8 avec ou sans BOM, ou ANSI) ; renvoie la liste des lignes découpées.
(defun tp:csv-read (path / lines sep)
  (setq lines (tp:read-lines path nil))
  (if (and lines (or (wcmatch (car lines) (strcat (chr 239) (chr 187) (chr 191) "*"))
                     (vl-some '(lambda (l) (vl-string-search (chr 195) l)) lines)))
    (setq lines (tp:read-lines path "utf8")))
  (if lines
    (progn
      (setq lines (cons (vl-string-left-trim (chr 65279) (car lines)) (cdr lines)))
      (setq sep (cond ((vl-string-search ";" (car lines)) ";")
                      ((vl-string-search "\t" (car lines)) "\t")
                      (T ",")))
      (mapcar '(lambda (l) (mapcar 'tp:trim (tp:csv-split l sep)))
              (vl-remove-if '(lambda (l) (= "" (tp:trim l))) lines)))))

;; Lignes de conversion : (source cible couleur type-de-ligne épaisseur).
(defun tp:conv-table (path / rows out r col lw)
  (setq rows (tp:csv-read path))
  (if (and rows (wcmatch (strcase (car (car rows))) "*SOURCE*,*CALQUE*")) (setq rows (cdr rows)))
  (foreach r rows
    (if (and (car r) (/= "" (car r)))
      (setq col (tp:num (nth 2 r))
            lw (tp:num (nth 4 r))
            out (cons (list (car r) (if (cadr r) (cadr r) "")
                            (if (and col (<= 1 col 255)) (fix col))
                            (if (and (nth 3 r) (/= "" (nth 3 r))) (nth 3 r))
                            (if lw (fix (+ 0.5 (* 100 lw)))))
                      out))))
  (reverse out))

(defun tp:src-match (lay src)
  (if (wcmatch src "*[*?]*")
    (wcmatch (strcase lay)
             (strcase (apply 'strcat (mapcar '(lambda (c) (if (member c '(42 63)) (chr c) (tp:wc-escape (chr c))))
                                             (vl-string->list src)))))
    (= (strcase lay) (strcase src))))

(defun tp:conv-lookup (lay / row tgt)
  (setq row (vl-some '(lambda (r) (if (tp:src-match lay (car r)) r)) tp:*convtable*))
  (if row
    (progn
      (setq tgt (cadr row))
      (cond
        ((= "" tgt) 'KEEP)
        ((member (strcase tgt) '("SUPPRIMER" "-")) 'DEL)
        ((not (snvalid tgt)) (tp:warn (strcat "Nom de calque invalide dans la table : " tgt)) 'KEEP)
        (T (tp:ensure-layer tgt (nth 2 row) (nth 3 row) (nth 4 row)) tgt)))
    'KEEP))

(defun tp:match-any (lay pats / u)
  (setq u (strcase lay))
  (vl-some '(lambda (p) (wcmatch u (strcase p))) pats))

;; Calque cible d'un calque : 'KEEP, 'DEL ou le nouveau nom (résultat mémorisé).
(defun tp:lay-target (lay / k p r)
  (setq k (strcase lay))
  (if (setq p (assoc k tp:*laymap*))
    (cdr p)
    (progn
      (setq r 'KEEP)
      (if (and tp:o-CALQUES_SUPPR (not (member k '("0" "DEFPOINTS")))
               (tp:match-any lay tp:o-CALQUES_FILTRE))
        (setq r 'DEL))
      (if (and tp:o-CALQUES_CACHES (member k tp:*hidden*)) (setq r 'DEL))
      (if (and (eq r 'KEEP) tp:*convtable*) (setq r (tp:conv-lookup lay)))
      (if (and (eq r 'DEL) (member k '("0" "DEFPOINTS"))) (setq r 'KEEP))
      (setq tp:*laymap* (cons (cons k r) tp:*laymap*))
      r)))

;;; --------------------------------------------------------------------------
;;; Textes multilignes : lecture, écriture, mise en forme
;;; --------------------------------------------------------------------------

(defun tp:mt-get (d / s one)
  (setq s "")
  (foreach p d
    (cond ((= 3 (car p)) (setq s (strcat s (cdr p))))
          ((= 1 (car p)) (setq one (cdr p)))))
  (strcat s (if one one "")))

(defun tp:mt-set (d s / chunks out done)
  (while (> (strlen s) 250)
    (setq chunks (cons (cons 3 (substr s 1 250)) chunks) s (substr s 251)))
  (setq chunks (reverse (cons (cons 1 s) chunks)))
  (foreach p d
    (if (member (car p) '(1 3))
      (if (not done) (setq out (append (reverse chunks) out) done T))
      (setq out (cons p out))))
  (reverse out))

;; Codes de mise en forme : f F C c H W Q T A p S L l O o K k.
(setq tp:*fmt-all* '(102 70 67 99 72 87 81 84 65 112 83 76 108 79 111 75 107))

;; Option « Textes multilignes sans mise en forme » : couleurs, polices, soulignés, barrés
;; hauteurs, largeurs, interlettrage et empilements sont conservés.
(setq tp:*fmt-mtext* '(67 99 102 70 76 108 79 111 75 107))

;; Retire les codes de mise en forme listés ; all = retirer aussi les accolades.
;; \P (paragraphe), \~, \\, \{, \} et \U+ sont conservés.
(defun tp:mt-unformat (s codes all / l out c n)
  (setq l (vl-string->list s))
  (while l
    (setq c (car l) l (cdr l))
    (cond
      ((and (= c 92) l)
       (setq n (car l) l (cdr l))
       (cond
         ((not (member n codes)) (setq out (cons n (cons c out))))
         ((member n '(76 108 79 111 75 107)) nil)
         ((= n 83)
          (while (and l (/= (car l) 59))
            (setq out (cons (if (member (car l) '(94 35)) 47 (car l)) out) l (cdr l)))
          (setq l (cdr l)))
         (T (while (and l (/= (car l) 59)) (setq l (cdr l))) (setq l (cdr l)))))
      ((and all (member c '(123 125))) nil)
      (T (setq out (cons c out)))))
  (vl-list->string (reverse out)))

(defun tp:mt-plain (s)
  (setq s (tp:mt-unformat s tp:*fmt-all* T))
  (tp:replace-all " " "\\~" (tp:replace-all " " "\\P" s)))

(defun tp:mt-trim (s / old)
  (while (/= s old)
    (setq old s s (vl-string-trim tp:*ws* s))
    (while (member (substr s 1 2) '("\\P" "\\~")) (setq s (substr s 3)))
    (while (and (> (strlen s) 1) (member (substr s (1- (strlen s))) '("\\P" "\\~")))
      (setq s (substr s 1 (- (strlen s) 2)))))
  s)

(defun tp:blank-text (d typ)
  (if (= typ "MTEXT")
    (= "" (tp:trim (tp:mt-plain (tp:mt-get d))))
    (= "" (tp:trim (if (tp:dxf 1 d) (tp:dxf 1 d) "")))))

;;; --------------------------------------------------------------------------
;;; Géométrie : aplatissement et longueurs
;;; --------------------------------------------------------------------------

(defun tp:pt3-p (p) (and (listp (cdr p)) (= 3 (length (cdr p)))))

;; Z = 0 pour les points des codes donnés (premières occurrences vérifiées d'abord : rapide).
(defun tp:z0 (codes d / need p)
  (foreach c codes (if (and (not need) (setq p (assoc c d)) (tp:pt3-p p) (/= 0.0 (cadddr p))) (setq need T)))
  (if need (tp:z0-all codes d) d))

;; Z = 0 pour toutes les occurrences (sommets de splines, de repères…).
(defun tp:z0-all (codes d)
  (mapcar '(lambda (p)
             (if (and (member (car p) codes) (tp:pt3-p p) (/= 0.0 (cadddr p)))
               (list (car p) (cadr p) (caddr p) 0.0)
               p))
          d))

;; Vecteurs : composante z retirée puis normalisés.
(defun tp:z0-vec (codes d)
  (mapcar '(lambda (p / x y l)
             (if (and (member (car p) codes) (tp:pt3-p p) (/= 0.0 (cadddr p)))
               (progn
                 (setq x (cadr p) y (caddr p) l (sqrt (+ (* x x) (* y y))))
                 (if (> l 1e-12) (list (car p) (/ x l) (/ y l) 0.0) p))
               p))
          d))

;; Extrusion parallèle à Z (objet dans un plan horizontal) ?
(defun tp:ext-z (d / n)
  (setq n (tp:dxf 210 d))
  (or (null n) (and (equal (car n) 0.0 1e-9) (equal (cadr n) 0.0 1e-9))))

(defun tp:flatten (d typ / ok)
  (setq ok (tp:ext-z d))
  (cond
    ((member typ '("LINE" "POINT" "3DFACE")) (setq d (tp:z0 '(10 11 12 13) d)))
    ((= typ "SPLINE")
     (setq d (tp:z0-vec '(12 13) (tp:z0-all '(10 11) d)))
     (if (not ok) (setq d (tp:put 210 '(0.0 0.0 1.0) d))))
    ((= typ "LEADER")
     (setq d (tp:z0-vec '(211) (tp:z0-all '(10 212 213) d)))
     (if (not ok) (setq d (tp:put 210 '(0.0 0.0 1.0) d))))
    ((= typ "POLYLINE")
     (setq tp:*plflat* (and (= 0 (logand (tp:dxf 70 d) 80)) (or ok (/= 0 (logand (tp:dxf 70 d) 8)))))
     (if tp:*plflat* (setq d (tp:z0 '(10) d))))
    ((= typ "VERTEX") (if tp:*plflat* (setq d (tp:z0 '(10) d))))
    ((member typ '("XLINE" "RAY")) (setq d (tp:z0-vec '(11) (tp:z0 '(10) d))))
    ((not ok) (if (member typ '("CIRCLE" "ARC" "ELLIPSE" "TEXT" "MTEXT" "INSERT" "HATCH" "LWPOLYLINE"))
                (setq tp:*noflat* (1+ tp:*noflat*))))
    ((member typ '("CIRCLE" "ARC" "ELLIPSE" "INSERT" "HATCH" "MTEXT" "WIPEOUT" "IMAGE")) (setq d (tp:z0 '(10) d)))
    ((member typ '("TEXT" "ATTRIB" "ATTDEF")) (setq d (tp:z0 '(10 11) d)))
    ((= typ "MLINE") (setq d (tp:z0-all '(10 11) d)))
    ((member typ '("SOLID" "TRACE")) (setq d (tp:z0 '(10 11 12 13) d)))
    ((= typ "DIMENSION") (setq d (tp:z0 '(10 11 12 13 14 15 16) d)))
    ((= typ "LWPOLYLINE") (if (and (tp:dxf 38 d) (/= 0.0 (tp:dxf 38 d))) (setq d (tp:put 38 0.0 d)))))
  (if (and (tp:dxf 39 d) (/= 0.0 (tp:dxf 39 d))) (setq d (tp:put 39 0.0 d)))
  d)

(defun tp:seg-len (p1 p2 b / c th)
  (setq c (distance p1 p2))
  (if (or (null b) (equal b 0.0 1e-12) (< c 1e-15))
    c
    (progn (setq th (* 4.0 (atan (abs b)))) (* (/ c (* 2.0 (sin (/ th 2.0)))) th))))

;; Sommets ((point renflement) …) ; longueur avec fermeture éventuelle.
(defun tp:verts-len (vs closed / len a)
  (setq len 0.0)
  (if vs
    (progn
      (setq a vs)
      (while (cdr a)
        (setq len (+ len (tp:seg-len (car (car a)) (car (cadr a)) (cadr (car a)))) a (cdr a)))
      (if closed (setq len (+ len (tp:seg-len (car (car a)) (car (car vs)) (cadr (car a))))))))
  len)

(defun tp:lw-verts (d / r)
  (foreach g d
    (cond ((= (car g) 10) (setq r (cons (list (cdr g) 0.0) r)))
          ((and (= (car g) 42) r) (setq r (cons (list (car (car r)) (cdr g)) (cdr r))))))
  (reverse r))

(defun tp:pl-verts (u)
  (mapcar '(lambda (v) (list (tp:dxf 10 v) (if (tp:dxf 42 v) (tp:dxf 42 v) 0.0)))
          (vl-remove-if-not '(lambda (v) (and (= "VERTEX" (tp:dxf 0 v)) (= 0 (logand 16 (tp:dxf 70 v)))))
                            (cdr u))))

(defun tp:poly-len (pts / len)
  (setq len 0.0)
  (while (cdr pts) (setq len (+ len (distance (car pts) (cadr pts))) pts (cdr pts)))
  len)

(defun tp:arc-sweep (s e / a)
  (setq a (- e s))
  (while (< a 0.0) (setq a (+ a (* 2.0 pi))))
  (if (equal a 0.0 1e-12) (* 2.0 pi) a))

(defun tp:ellipse-len (d / v a b h per frac)
  (setq v (tp:dxf 11 d) a (distance '(0.0 0.0 0.0) v) b (* a (tp:dxf 40 d)))
  (setq per (* pi (- (* 3.0 (+ a b)) (sqrt (* (+ (* 3.0 a) b) (+ a (* 3.0 b)))))))
  (setq frac (/ (tp:arc-sweep (tp:dxf 41 d) (tp:dxf 42 d)) (* 2.0 pi)))
  (* per frac))

(defun tp:curve-len (u typ / d)
  (setq d (car u))
  (cond
    ((= typ "LINE") (distance (tp:dxf 10 d) (tp:dxf 11 d)))
    ((= typ "ARC") (* (tp:dxf 40 d) (tp:arc-sweep (tp:dxf 50 d) (tp:dxf 51 d))))
    ((= typ "CIRCLE") (* 2.0 pi (tp:dxf 40 d)))
    ((= typ "LWPOLYLINE") (tp:verts-len (tp:lw-verts d) (= 1 (logand 1 (tp:dxf 70 d)))))
    ((= typ "POLYLINE")
     (if (= 0 (logand (tp:dxf 70 d) 80)) (tp:verts-len (tp:pl-verts u) (= 1 (logand 1 (tp:dxf 70 d))))))
    ((= typ "ELLIPSE") (tp:ellipse-len d))
    ((= typ "SPLINE")
     (tp:poly-len (mapcar 'cdr (vl-remove-if-not '(lambda (p) (= 10 (car p))) d))))))

(defun tp:too-small (u typ / d lim len p l g)
  (setq d (car u) lim (if (and (numberp tp:o-TOL) (> tp:o-TOL 0.0)) tp:o-TOL 1e-9))
  (cond
    ((= typ "LINE") (< (distance (tp:dxf 10 d) (tp:dxf 11 d)) lim))
    ((= typ "LWPOLYLINE")
     ;; somme des cordes arrêtée dès la limite atteinte ; longueur exacte (arcs) seulement en dessous
     (setq len 0.0 l d)
     (while (and l (< len lim))
       (setq g (car l) l (cdr l))
       (if (= 10 (car g)) (progn (if p (setq len (+ len (distance p (cdr g))))) (setq p (cdr g)))))
     (and (< len lim) (< (tp:curve-len u typ) lim)))
    ((member typ '("ARC" "CIRCLE" "POLYLINE" "ELLIPSE" "SPLINE"))
     (and (setq len (tp:curve-len u typ)) (< len lim)))))

;;; --------------------------------------------------------------------------
;;; Traitement d'un objet
;;; Une « unité » est la liste des listes DXF d'un objet : l'objet principal suivi
;;; de ses sous-objets (attributs ou sommets, puis SEQEND).
;;; --------------------------------------------------------------------------

;; Raison de suppression (libellé du rapport) ou nil.
(defun tp:del-reason (u / d typ)
  (setq d (car u) typ (tp:dxf 0 d))
  (cond
    ((= typ "VIEWPORT") nil)
    ((and tp:*lay-del* (eq (tp:lay-target (tp:dxf 8 d)) 'DEL)) "Objets des calques supprimés")
    ((member typ '("LINE" "LWPOLYLINE" "ARC" "CIRCLE" "POLYLINE" "ELLIPSE" "SPLINE"))
     (if (and tp:o-PETITS (tp:too-small u typ)) "Objets trop petits supprimés"))
    ((member typ '("TEXT" "MTEXT")) (if (and tp:o-TEXTES (tp:blank-text d typ)) "Textes vides supprimés"))
    ((= typ "INSERT")
     (if (and tp:o-BLOCS_VIDES tp:*empty* (member (strcase (tp:dxf 2 d)) tp:*empty*))
       "Références de blocs vides supprimées"))
    ((= typ "HATCH")
     (if (and tp:o-HACH_SOLIDES (or (= 1 (tp:dxf 70 d)) (wcmatch (strcase (tp:dxf 2 d)) "SOLID,_SOLID,SOLID`,_O")))
       (if (wcmatch (strcase (tp:dxf 8 d)) "PDF*")
         ;; import PDF : les textes y sont dessinés par des hachures pleines, on les garde
         (progn (tp:warn "Hachures pleines d'un import PDF conservées (elles dessinent aussi les textes).") nil)
         "Hachures pleines supprimées")))
    ((= typ "WIPEOUT") (if tp:o-MASQUES "Masques (wipeouts) supprimés"))
    ((= typ "SOLID") (if tp:o-SOLIDES2D "Solides 2D supprimés"))
    ((= typ "ACAD_PROXY_ENTITY") (if tp:o-PROXY "Objets proxy supprimés"))))

(defun tp:map-color (c / p)
  (cond ((setq p (assoc c tp:o-COUL_TABLE)) (cdr p))
        ((setq p (assoc 256 tp:o-COUL_TABLE)) (cdr p))))

(defun tp:set-color (d c)
  (if (or (/= c (if (tp:dxf 62 d) (tp:dxf 62 d) 256)) (assoc 420 d) (assoc 430 d))
    (tp:put 62 c (tp:drop '(420 430) d))
    d))

(defun tp:mod-color (d ctx / c dst)
  (setq c (tp:dxf 62 d))
  (if (null c) (setq c 256))
  (if tp:o-COULEURS
    (cond
      ((and tp:o-COUL_FORCEES (< 0 c 256) (setq dst (tp:map-color c)))
       (setq d (tp:set-color d dst)))
      ((and tp:o-COUL_DUCALQUE (= c 256) (not (and (eq ctx 'BLOCK) (= "0" (tp:dxf 8 d))))
            (setq dst (tp:map-color (tp:layer-color (tp:dxf 8 d)))))
       (setq d (tp:set-color d dst)))))
  (if (and tp:o-COULEUR_UNIQUE tp:o-CU_ENTITES)
    (setq d (tp:set-color d (if (eq ctx 'BLOCK) 0 tp:o-COUL_UNIQUE))))
  (if (and tp:o-DUCALQUE (eq ctx 'SPACE)) (setq d (tp:set-color d 256)))
  (if (and tp:o-DUBLOC (eq ctx 'BLOCK)) (setq d (tp:set-color d 0)))
  d)

(defun tp:mod-ltype (d ctx / lt dst)
  (setq lt (tp:dxf 6 d))
  (if (and lt tp:o-TYPESLIGNE (setq dst (cdr (assoc (strcase lt) tp:*lttable*))))
    (setq d (tp:put 6 dst d) lt dst))
  (if (and lt tp:o-TL_DUCALQUE (eq ctx 'SPACE) (/= (strcase lt) "BYLAYER"))
    (setq d (tp:put 6 "BYLAYER" d)))
  (if (and tp:o-TL_ECHELLE1 (tp:dxf 48 d) (/= 1.0 (tp:dxf 48 d))) (setq d (tp:put 48 1.0 d)))
  d)

(defun tp:mod-lweight (d ctx / w)
  (setq w (tp:dxf 370 d))
  (if (and w tp:o-EP_DUCALQUE)
    (cond ((and (eq ctx 'SPACE) (/= w -1)) (setq d (tp:put 370 -1 d)))
          ((and (eq ctx 'BLOCK) (>= w 0)) (setq d (tp:put 370 -2 d)))))
  d)

(defun tp:mod-layer (d typ ctx / tgt)
  (setq tgt (tp:lay-target (tp:dxf 8 d)))
  (if (= 'STR (type tgt)) (setq d (tp:put 8 tgt d)))
  (if (eq ctx 'SPACE)
    (cond ((and tp:o-COTES_CALQUE (= typ "DIMENSION")) (setq d (tp:put 8 tp:o-NOM_COTES d)))
          ((and tp:o-HACH_CALQUE (= typ "HATCH")) (setq d (tp:put 8 tp:o-NOM_HACH d)))))
  d)

(defun tp:trim-text (d typ / s s2)
  (cond
    ((and (member typ '("TEXT" "ATTRIB")) (setq s (tp:dxf 1 d)))
     (setq s2 (tp:trim s))
     (if (/= s s2) (tp:put 1 s2 d) d))
    ((= typ "MTEXT")
     (setq s (tp:mt-get d) s2 (tp:mt-trim s))
     (if (/= s s2) (tp:mt-set d s2) d))
    (T d)))

(defun tp:mod-text (d typ / s s2 codes)
  (if (and tp:o-STYLES (member typ '("TEXT" "MTEXT" "ATTRIB" "ATTDEF"))
           (/= (strcase (tp:dxf 7 d)) (strcase tp:o-STYLE_NOM)))
    (setq d (tp:put 7 tp:o-STYLE_NOM d)))
  (setq codes tp:*mt-codes*)
  (cond
    ((and codes (= typ "MTEXT"))
     (setq s (tp:mt-get d) s2 (tp:mt-unformat s codes nil))
     (if (/= s s2) (setq d (tp:mt-set d s2)))
     ;; masque d'arrière-plan : AutoCAD refuse de le retirer par entmod, l'objet sera recréé
     (if (and tp:o-MTEXT (tp:dxf 90 d) (/= 0 (tp:dxf 90 d))) (setq d (tp:drop '(90 63 45 441 421 431) d))))
    ((and codes (= typ "DIMENSION") (tp:dxf 1 d) (/= "" (tp:dxf 1 d)))
     (setq s (tp:dxf 1 d) s2 (tp:mt-unformat s codes nil))
     (if (/= s s2) (setq d (tp:put 1 s2 d)))))
  d)

;; Données étendues : retire les applications AEC (Architecture, MEP, Civil 3D).
(defun tp:drop-aec-xdata (d / x keep)
  (if (setq x (assoc -3 d))
    (progn
      (setq keep (vl-remove-if '(lambda (a) (wcmatch (strcase (car a)) "AEC*")) (cdr x)))
      (if (/= (length keep) (length (cdr x)))
        (setq d (append (vl-remove x d) (if keep (list (cons -3 keep))))))))
  d)

;; Couleurs des cotes : retire les remplacements de couleur (DIMCLRD/E/T) des données étendues.
(defun tp:drop-dim-colors (d / x acad out l)
  (if (and (setq x (assoc -3 d)) (setq acad (assoc "ACAD" (cdr x))))
    (progn
      (setq l (cdr acad))
      (while l
        (if (and (equal (car l) '(1070 . 176)) (cadr l)) (setq l (cddr l))
          (if (and (member (car l) '((1070 . 177) (1070 . 178))) (cadr l)) (setq l (cddr l))
            (setq out (cons (car l) out) l (cdr l)))))
      (setq out (reverse out))
      (if (/= (length out) (length (cdr acad)))
        (setq d (subst (cons -3 (subst (cons "ACAD" out) acad (cdr x))) x d)))))
  d)

(defun tp:modify (d ctx / typ)
  (setq typ (tp:dxf 0 d))
  (if (/= typ "SEQEND")
    (progn
      (if tp:*lay-ops* (setq d (tp:mod-layer d typ ctx)))
      (if tp:o-APLATIR (setq d (tp:flatten d typ)))
      (if (and tp:o-TEXTES (member typ '("TEXT" "MTEXT" "ATTRIB"))) (setq d (tp:trim-text d typ)))
      (if tp:*col-ops* (setq d (tp:mod-color d ctx)))
      (if tp:*lt-ops* (setq d (tp:mod-ltype d ctx)))
      (if tp:o-EP_DUCALQUE (setq d (tp:mod-lweight d ctx)))
      (if (and tp:*txt-ops* (member typ '("TEXT" "MTEXT" "ATTRIB" "ATTDEF" "DIMENSION"))) (setq d (tp:mod-text d typ)))
      (if (and tp:o-COTES_DUBLOC (member typ '("DIMENSION" "LEADER"))) (setq d (tp:drop-dim-colors d)))
      (if tp:o-PROXY (setq d (tp:drop-aec-xdata d)))))
  d)

;; Traite une unité : renvoie 'DEL, (EXPL . listes DXF) ou la liste des listes modifiées.
(defun tp:unit (u ctx / d typ why)
  (setq d (car u) typ (tp:dxf 0 d))
  (cond
    ((and tp:*skip* (member (strcase (tp:dxf 8 d)) tp:*skip*)) u)
    ((setq why (tp:del-reason u)) (setq tp:*why* why) 'DEL)
    ((and tp:*can-expl* tp:o-NEXPL (= typ "INSERT") (tp:explodable d))
     (cons 'EXPL (tp:process-lists (tp:nexpl u) ctx)))
    (T (mapcar '(lambda (x) (tp:modify x ctx)) u))))

;; Regroupe des listes DXF en unités (sous-objets rattachés à l'objet précédent).
(defun tp:group-units (lists / units cur)
  (foreach d lists
    (if (and cur (member (tp:dxf 0 d) '("ATTRIB" "VERTEX" "SEQEND")))
      (setq cur (cons d cur))
      (progn (if cur (setq units (cons (reverse cur) units))) (setq cur (list d)))))
  (if cur (setq units (cons (reverse cur) units)))
  (reverse units))

;; Traite des listes sans nom d'entité (résultats d'une décomposition).
(defun tp:process-lists (lists ctx / out r old)
  (setq old tp:*can-expl* tp:*can-expl* nil)
  (foreach u (tp:group-units lists)
    (setq r (tp:unit u ctx))
    (if (eq r 'DEL) (tp:note tp:*why* 1) (setq out (append out r))))
  (setq tp:*can-expl* old)
  out)

;; Écrit les modifications d'une unité existante (entmod), en retirant au besoin des données étendues.
(defun tp:entmod-diff (old new / x0 x1 gone)
  (if (and (setq x0 (assoc -3 old)) (setq x1 (assoc -3 new)))
    (setq gone (vl-remove-if '(lambda (a) (assoc (car a) (cdr x1))) (cdr x0)))
    (if x0 (setq gone (cdr x0))))
  (if gone
    (setq new (append (vl-remove x1 new)
                      (list (cons -3 (append (if x1 (cdr x1)) (mapcar '(lambda (a) (list (car a))) gone)))))))
  (entmod new))

;; Modification impossible par entmod : l'objet doit être recréé (masque de texte multiligne).
(defun tp:needs-recreate (old new)
  (and (= "MTEXT" (tp:dxf 0 old)) (tp:dxf 90 old) (/= 0 (tp:dxf 90 old)) (null (assoc 90 new))))

(defun tp:commit-unit (u r ctx / changed sub old)
  (mapcar
    '(lambda (old new)
       (cond
         ((and (eq ctx 'SPACE) (tp:needs-recreate old new))
          (if (entmake (tp:clean new)) (progn (entdel (tp:dxf -1 old)) (setq changed T))))
         ((or (not (equal old new))
              (and tp:o-COTES_DUBLOC (= "DIMENSION" (tp:dxf 0 old))))
          (tp:entmod-diff old new)
          (setq changed T)
          (if (not (eq old (car u))) (setq sub T)))))
    u r)
  (if (and sub (eq ctx 'SPACE)) (entupd (tp:dxf -1 (car u))))
  (if changed (tp:note "Objets modifiés" 1)))

;;; --------------------------------------------------------------------------
;;; Décomposition des blocs imbriqués (par EXPLODE dans l'espace objet)
;;; --------------------------------------------------------------------------

(defun tp:explodable (d / b)
  (and (<= (if (tp:dxf 70 d) (tp:dxf 70 d) 1) 1)
       (<= (if (tp:dxf 71 d) (tp:dxf 71 d) 1) 1)
       (setq b (tblsearch "BLOCK" (tp:dxf 2 d)))
       (= 0 (logand 52 (tp:dxf 70 b)))))

;; Propriétés transmises aux composants : (calque couleur vraie-couleur type-de-ligne épaisseur).
(defun tp:props (d)
  (list (tp:dxf 8 d) (if (tp:dxf 62 d) (tp:dxf 62 d) 256) (assoc 420 d)
        (if (tp:dxf 6 d) (tp:dxf 6 d) "BYLAYER") (if (tp:dxf 370 d) (tp:dxf 370 d) -1)))

;; Les composants sur le calque 0 ou DuBloc prennent les propriétés de la référence.
(defun tp:byblock (d props)
  (if (and (tp:dxf 8 d) (= "0" (tp:dxf 8 d)) (/= "0" (car props))) (setq d (tp:put 8 (car props) d)))
  (if (= 0 (tp:dxf 62 d))
    (setq d (if (caddr props) (append (tp:put 62 (cadr props) d) (list (caddr props))) (tp:put 62 (cadr props) d))))
  (if (and (tp:dxf 6 d) (= "BYBLOCK" (strcase (tp:dxf 6 d)))) (setq d (tp:put 6 (nth 3 props) d)))
  (if (= -2 (tp:dxf 370 d)) (setq d (tp:put 370 (nth 4 props) d)))
  d)

;; Liste DXF prête pour entmake : sans nom, poignée, propriétaire ni réacteurs.
(defun tp:clean (d / out skip typ stop)
  (setq typ (tp:dxf 0 d))
  (foreach p d
    (cond
      (stop nil)
      ((equal p '(101 . "Embedded Object")) (setq stop T))
      ((= (car p) 102) (setq skip (wcmatch (cdr p) "{*")))
      (skip nil)
      ((member (car p) '(-1 5 330 360)) nil)
      ((and (= typ "LEADER") (= (car p) 340)) nil)
      ((and (= typ "HATCH") (= (car p) 97)) (setq out (cons '(97 . 0) out)))
      ((and (= typ "HATCH") (= (car p) 71)) (setq out (cons '(71 . 0) out)))
      (T (setq out (cons p out)))))
  (if (and stop (setq skip (assoc -3 d))) (setq out (cons skip out)))
  (reverse out))

(defun tp:att->text (a / v)
  (setq v (tp:dxf 1 a))
  (if (and v (= 0 (logand 1 (if (tp:dxf 70 a) (tp:dxf 70 a) 0))) (/= "" (tp:trim v)))
    (vl-remove nil
      (list '(0 . "TEXT") (assoc 8 a) (assoc 62 a) (assoc 420 a) (assoc 6 a) (assoc 370 a) (assoc 48 a)
            (assoc 39 a) (assoc 10 a) (assoc 40 a) (cons 1 (tp:replace-all " " "\\P" v)) (assoc 50 a)
            (assoc 41 a) (assoc 51 a) (assoc 7 a) (assoc 71 a) (assoc 72 a) (assoc 11 a)
            (if (tp:dxf 74 a) (cons 73 (tp:dxf 74 a))) (assoc 210 a)))))

(defun tp:atts->texts (u / out t1)
  (foreach a (cdr u)
    (if (and (= "ATTRIB" (tp:dxf 0 a)) (setq t1 (tp:att->text a))) (setq out (cons t1 out))))
  out)

(defun tp:units-after (mark / e d units cur)
  (setq e (if mark (entnext mark) (entnext)))
  (while e
    (setq d (entget e '("*")))
    (if (and cur (member (tp:dxf 0 d) '("ATTRIB" "VERTEX" "SEQEND")))
      (setq cur (cons d cur))
      (progn (if cur (setq units (cons (reverse cur) units))) (setq cur (list d))))
    (setq e (entnext e)))
  (if cur (setq units (cons (reverse cur) units)))
  (reverse units))

;; Décompose complètement une référence imbriquée ; renvoie les listes DXF des objets
;; simples obtenus (coordonnées du bloc parent). Les attributs deviennent des textes.
(defun tp:nexpl (u / out work w e props mark d typ t1)
  (setq out (tp:atts->texts u) mark (entlast))
  (if (entmake (tp:drop '(66) (tp:clean (car u))))
    (setq work (list (list (entlast) (tp:props (car u))))))
  (while work
    (setq w (car work) work (cdr work) e (car w) props (cadr w) mark (entlast))
    (command "_.EXPLODE" e)
    (tp:end-cmd)
    (if (entget e)
      (progn                                 ; décomposition impossible : la référence reste
        (setq out (cons (tp:clean (entget e '("*"))) out))
        (entdel e)
        (tp:warn "Certaines références imbriquées n'ont pas pu être décomposées (blocs non décomposables)."))
      (foreach x (tp:units-after mark)
        (setq x (mapcar '(lambda (d) (tp:byblock d props)) x) d (car x) typ (tp:dxf 0 d))
        (cond
          ((and (= typ "INSERT") (tp:explodable d))
           (entmod d)
           (setq out (append (tp:atts->texts x) out)
                 work (cons (list (tp:dxf -1 d) (tp:props d)) work)))
          ((= typ "ATTDEF")
           (if (and (/= 0 (logand 2 (tp:dxf 70 d))) (setq t1 (tp:att->text d))) (setq out (cons t1 out)))
           (entdel (tp:dxf -1 d)))
          (T
           (setq out (append (reverse (mapcar 'tp:clean x)) out))
           (entdel (tp:dxf -1 d)))))))
  (tp:note "Références imbriquées décomposées" 1)
  (reverse out))

;;; --------------------------------------------------------------------------
;;; Définitions de blocs
;;; --------------------------------------------------------------------------

(setq tp:*safe-types*
  '("LINE" "ARC" "CIRCLE" "ELLIPSE" "LWPOLYLINE" "POLYLINE" "VERTEX" "SEQEND" "SPLINE" "TEXT" "MTEXT"
    "ATTDEF" "ATTRIB" "INSERT" "HATCH" "SOLID" "TRACE" "3DFACE" "POINT" "DIMENSION" "LEADER" "XLINE"
    "RAY" "WIPEOUT" "SHAPE" "TOLERANCE"))

(defun tp:xdict (d / l)
  (if (setq l (member '(102 . "{ACAD_XDICTIONARY") d)) (cdr (cadr l))))

(defun tp:dynamic-p (name / rec x)
  (setq rec (entget (tp:dxf 330 (entget (tblobjname "BLOCK" name)))))
  (and (setq x (tp:xdict rec)) (dictsearch x "ACAD_ENHANCEDBLOCK")))

;; Blocs traités : définitions nommées et anonymes *U (ni xref, ni présentations, ni cotes).
(defun tp:block-names (/ d n r)
  (setq d (tblnext "BLOCK" T))
  (while d
    (setq n (tp:dxf 2 d))
    (if (and (= 0 (logand 52 (tp:dxf 70 d)))
             (or (/= "*" (substr n 1 1)) (wcmatch (strcase n) "`*U*")))
      (setq r (cons n r)))
    (setq d (tblnext "BLOCK")))
  (reverse r))

(defun tp:block-units (name / e lists)
  (setq e (entnext (tblobjname "BLOCK" name)))
  (while e (setq lists (cons (entget e '("*")) lists) e (entnext e)))
  (tp:group-units (reverse lists)))

(defun tp:empty-blocks (/ r)
  (foreach n (tp:block-names)
    (if (null (entnext (tblobjname "BLOCK" n))) (setq r (cons (strcase n) r))))
  r)

;; Redéfinit un bloc nommé avec de nouvelles listes DXF ; nil si AutoCAD refuse (l'original reste).
(defun tp:redefine (name lists / hdr ok attdef)
  (setq hdr (entget (tblobjname "BLOCK" name)) ok T)
  (setq attdef (vl-some '(lambda (d) (= "ATTDEF" (tp:dxf 0 d))) lists))
  (entmake (vl-remove nil
             (list '(0 . "BLOCK") (cons 2 name)
                   (cons 70 (if attdef (logior 2 (logand (tp:dxf 70 hdr) 1)) (logand (tp:dxf 70 hdr) 1)))
                   (assoc 10 hdr) (assoc 4 hdr))))
  (foreach d lists (if ok (setq ok (entmake (tp:clean d)))))
  (and (entmake '((0 . "ENDBLK"))) ok))

(defun tp:process-block (name / units results redef r lists types ok del)
  (setq units (tp:block-units name))
  (setq redef (and (/= "*" (substr name 1 1)) (not (tp:dynamic-p name))))
  (setq tp:*can-expl* redef)
  (foreach u units
    (setq r (tp:unit u 'BLOCK))
    (if (eq r 'DEL) (setq r (cons 'DEL tp:*why*)))
    (setq results (cons (cons u r) results)))
  (setq results (reverse results) tp:*can-expl* nil)
  (setq del (vl-some '(lambda (x) (or (member (cadr x) '(DEL EXPL))
                                      (vl-some 'tp:needs-recreate (car x) (cdr x))))
                     results))
  (if (and redef del)
    (progn
      (foreach x results
        (cond ((eq (cadr x) 'DEL))
              ((eq (cadr x) 'EXPL) (setq lists (append lists (cddr x))))
              (T (setq lists (append lists (cdr x))))))
      (setq types (vl-remove-if '(lambda (d) (member (tp:dxf 0 d) tp:*safe-types*)) lists))
      (if (and (null types) (tp:redefine name lists))
        (progn
          (foreach x results (if (eq (cadr x) 'DEL) (tp:note (cddr x) 1)))
          (tp:note "Blocs redéfinis" 1)
          (setq ok T))
        (tp:warn (strcat "Bloc « " name " » : redéfinition impossible, les objets à supprimer sont masqués.")))))
  (if (not ok)
    (foreach x results
      (cond
        ((eq (cadr x) 'DEL)
         (entmod (tp:put 60 1 (car (car x))))
         (tp:note "Objets masqués dans des blocs (non redéfinissables)" 1))
        ((eq (cadr x) 'EXPL))
        (T (tp:commit-unit (car x) (cdr x) 'BLOCK))))))

(defun tp:block-pass ()
  (foreach n (tp:block-names) (tp:process-block n)))

;;; --------------------------------------------------------------------------
;;; Espaces objet et papier
;;; --------------------------------------------------------------------------

(defun tp:unit-of (e / d u n)
  (setq d (if tp:*xd* (entget e tp:*xd*) (entget e)) u (list d))
  (if (or (and (= "INSERT" (tp:dxf 0 d)) (= 1 (tp:dxf 66 d))) (= "POLYLINE" (tp:dxf 0 d)))
    (progn
      (setq n (entnext e))
      (while (and n (setq d (if tp:*xd* (entget n tp:*xd*) (entget n))) (member (tp:dxf 0 d) '("ATTRIB" "VERTEX" "SEQEND")))
        (setq u (cons d u) n (if (= "SEQEND" (tp:dxf 0 d)) nil (entnext n))))))
  (reverse u))

(defun tp:space-pass (/ ss i e u r)
  (if (setq ss (ssget "_X"))
    (progn
      (setq i 0)
      (repeat (sslength ss)
        (setq e (ssname ss i) i (1+ i))
        (if (entget e)
          (progn
            (setq u (tp:unit-of e) r (tp:unit u 'SPACE))
            (cond
              ((eq r 'DEL) (if (entdel e) (tp:note tp:*why* 1)))
              (T (tp:commit-unit u r 'SPACE)))))))))

;;; --------------------------------------------------------------------------
;;; Opérations sur les tables et le dessin
;;; --------------------------------------------------------------------------

(defun tp:layer-table-ops (/ e d c nc set lt dst n)
  (setq n 0)
  (foreach l (tp:layer-list)
    (if (= 0 (logand (cadr l) 16))
      (progn
        (setq e (tblobjname "LAYER" (car l)) d (entget e) c (tp:dxf 62 d) nc (abs c) set nil)
        (if (and tp:o-COULEURS tp:o-COUL_CALQUES (tp:map-color nc))
          (setq nc (tp:map-color nc) set T))
        (if (and tp:o-COULEUR_UNIQUE tp:o-CU_CALQUES) (setq nc tp:o-COUL_UNIQUE set T))
        (if (and set (or (/= nc (abs c)) (assoc 420 d)))
          (setq d (tp:put 62 (if (< c 0) (- nc) nc) (tp:drop '(420 430) d))))
        (setq lt (tp:dxf 6 d))
        (if (and lt tp:o-TYPESLIGNE (setq dst (cdr (assoc (strcase lt) tp:*lttable*))))
          (setq d (tp:put 6 dst d)))
        (if (not (equal d (entget e))) (progn (entmod d) (setq n (1+ n)))))))
  (tp:note "Calques modifiés" n))

(defun tp:styles-font (font / d ed n)
  (setq n 0 d (tblnext "STYLE" T))
  (while d
    (if (and (= 0 (logand (tp:dxf 70 d) 17)) (/= "" (tp:dxf 2 d))
             (/= (strcase (tp:dxf 3 d)) (strcase font)))
      (progn
        (setq ed (entget (tblobjname "STYLE" (tp:dxf 2 d)) '("ACAD")))
        (setq ed (tp:put 4 "" (tp:put 3 font (vl-remove (assoc -3 ed) ed))))
        (if (assoc -3 (entget (tblobjname "STYLE" (tp:dxf 2 d)) '("ACAD")))
          (setq ed (append ed (list '(-3 ("ACAD"))))))
        (if (entmod ed) (setq n (1+ n)))))
    (setq d (tblnext "STYLE")))
  (tp:note "Styles de texte : police remplacée" n))

(defun tp:ensure-style (name / font)
  (if (not (tblsearch "STYLE" name))
    (progn
      (setq font tp:o-POLICE)
      (if (or (null font) (= font "")) (setq font "arial.ttf"))
      (entmake (list '(0 . "STYLE") '(100 . "AcDbSymbolTableRecord") '(100 . "AcDbTextStyleTableRecord")
                     (cons 2 name) '(70 . 0) '(40 . 0.0) '(41 . 1.0) '(50 . 0.0) '(71 . 0) '(42 . 2.5)
                     (cons 3 font) '(4 . ""))))))

;; Couleurs des lignes de cote, d'attache et des textes DuBloc dans tous les styles de cote
;; (entmod n'agit pas sur les styles : chaque style est restauré, modifié puis réenregistré).
(defun tp:dimstyles-byblock (/ cur n i)
  (setq cur (getvar "DIMSTYLE") n 0)
  (foreach s (tp:table-names "DIMSTYLE")
    (command "_.-DIMSTYLE" "_R" s) (tp:end-cmd)
    (if (or (/= 0 (getvar "DIMCLRD")) (/= 0 (getvar "DIMCLRE")) (/= 0 (getvar "DIMCLRT")))
      (progn
        (setvar "DIMCLRD" 0) (setvar "DIMCLRE" 0) (setvar "DIMCLRT" 0)
        (command "_.-DIMSTYLE" "_S" s)
        (setq i 0)
        (while (and (> (logand 1 (getvar "CMDACTIVE")) 0) (< i 3)) (command "_Y") (setq i (1+ i)))
        (tp:end-cmd)
        (setq n (1+ n)))))
  (command "_.-DIMSTYLE" "_R" cur) (tp:end-cmd)
  (tp:note "Styles de cote passés en DuBloc" n))

(defun tp:layout-names (/ r)
  (foreach p (dictsearch (namedobjdict) "ACAD_LAYOUT")
    (if (and (= 3 (car p)) (/= "MODEL" (strcase (cdr p)))) (setq r (cons (cdr p) r))))
  r)

(defun tp:paper-count (/ ss) (if (setq ss (ssget "_X" '((67 . 1) (-4 . "<NOT") (0 . "VIEWPORT") (-4 . "NOT>")))) (sslength ss) 0))

(defun tp:del-layouts (/ names left n0)
  (setq names (tp:layout-names) n0 (tp:paper-count))
  (setvar "TILEMODE" 1)
  (foreach nm names (command "_.-LAYOUT" "_D" nm) (tp:end-cmd))
  (setq left (tp:layout-names))
  (tp:note "Présentations supprimées" (length (vl-remove-if '(lambda (x) (member x left)) names)))
  (tp:note "Objets d'espace papier supprimés avec les présentations" (- n0 (tp:paper-count))))

(defun tp:block-referenced (n)
  (ssget "_X" (list '(0 . "INSERT") (cons 2 (tp:wc-escape n)))))

;; Modes : INTROUVABLES, NONREF (introuvables et non référencées), TOUTES,
;; LIER (xrefs trouvées insérées dans le dessin, introuvables détachées).
(defun tp:xrefs (mode / d n f lst bind found)
  (setq d (tblnext "BLOCK" T))
  (while d
    (setq n (tp:dxf 2 d) f (tp:dxf 70 d))
    (if (and (= 4 (logand f 4)) (= 0 (logand f 16)))
      (progn
        (setq found (or (/= 0 (logand f 32)) (tp:file-found (tp:dxf 1 d))))
        (cond
          ((or (= mode "TOUTES") (not found) (and (= mode "NONREF") (not (tp:block-referenced n))))
           (setq lst (cons n lst)))
          ((= mode "LIER") (setq bind (cons n bind))))))
    (setq d (tblnext "BLOCK")))
  (foreach n lst (command "_.-XREF" "_D" n) (tp:end-cmd))
  (tp:note "Xrefs détachées" (length lst))
  (if bind
    (progn
      (setvar "BINDTYPE" 1)
      (foreach n bind (command "_.-XREF" "_B" n) (tp:end-cmd))
      (tp:note "Xrefs liées (insérées dans le dessin)"
               (length (vl-remove-if '(lambda (n) (and (tblsearch "BLOCK" n) (/= 0 (logand 4 (tp:dxf 70 (tblsearch "BLOCK" n)))))) bind))))))

(defun tp:image-used (def / ss i used)
  (if (setq ss (ssget "_X" '((0 . "IMAGE"))))
    (progn
      (setq i 0)
      (repeat (sslength ss)
        (if (equal def (tp:dxf 340 (entget (ssname ss i)))) (setq used T))
        (setq i (1+ i)))))
  used)

(defun tp:images (mode / dict name lst def)
  (if (setq dict (dictsearch (namedobjdict) "ACAD_IMAGE_DICT"))
    (progn
      (foreach p dict
        (cond ((= 3 (car p)) (setq name (cdr p)))
              ((and (= 350 (car p)) name)
               (setq def (entget (cdr p)))
               (if (or (= mode "TOUTES")
                       (not (tp:file-found (tp:dxf 1 def)))
                       (and (= mode "NONREF") (not (tp:image-used (cdr p)))))
                 (setq lst (cons name lst)))
               (setq name nil))))
      (foreach n lst (command "_.-IMAGE" "_D" n) (tp:end-cmd))
      (tp:note "Images détachées" (length lst)))))

(defun tp:groups (/ gd name cnt lst)
  (if (setq gd (dictsearch (namedobjdict) "ACAD_GROUP"))
    (progn
      (foreach p gd
        (cond ((= 3 (car p)) (setq name (cdr p)))
              ((and (= 350 (car p)) name)
               (setq cnt 0)
               (foreach q (entget (cdr p)) (if (and (= 340 (car q)) (entget (cdr q))) (setq cnt (1+ cnt))))
               (if (< cnt 2) (setq lst (cons (cons name (cdr p)) lst)))
               (setq name nil))))
      (foreach g lst (dictremove (tp:dxf -1 gd) (car g)) (entdel (cdr g)))
      (tp:note "Groupes vides supprimés" (length lst)))))

(defun tp:aec-dicts (/ lst)
  (foreach p (entget (namedobjdict))
    (if (and (= 3 (car p)) (wcmatch (strcase (cdr p)) "AEC_*,AECC_*,AECB_*")) (setq lst (cons (cdr p) lst))))
  (foreach n lst (dictremove (namedobjdict) n))
  (tp:note "Dictionnaires AEC supprimés" (length lst)))

(setq tp:*units*
  '((4 "Millimètres" 0.001) (5 "Centimètres" 0.01) (14 "Décimètres" 0.1) (6 "Mètres" 1.0)
    (1 "Pouces" 0.0254) (2 "Pieds" 0.3048)))

(defun tp:unit-factor (u) (caddr (assoc u tp:*units*)))

(defun tp:model-ss () (ssget "_X" '((410 . "Model"))))

(defun tp:units-apply (/ src dst f ss)
  (setq dst tp:o-UNITE)
  (if tp:o-CONVUNITE
    (progn
      (setq src (if (= 0 tp:o-UNITE_SRC) (getvar "INSUNITS") tp:o-UNITE_SRC))
      (cond
        ((not (tp:unit-factor src))
         (tp:warn "Unité d'origine inconnue (INSUNITS = 0) : mise à l'échelle non effectuée."))
        ((and (tp:unit-factor dst) (/= src dst))
         (setq f (/ (tp:unit-factor src) (tp:unit-factor dst)))
         (if (setq ss (tp:model-ss))
           (progn
             (command "_.SCALE" ss "" '(0.0 0.0 0.0) f) (tp:end-cmd)
             (setvar "LTSCALE" (* (getvar "LTSCALE") f))
             (tp:note "Objets mis à l'échelle" (sslength ss))))
         (tp:warn (strcat "Dessin mis à l'échelle × " (rtos f 2 4) " (les présentations ne sont pas adaptées)."))))))
  (if (tp:unit-factor dst) (setvar "INSUNITS" dst))
  (setvar "LUNITS" 2)
  (setvar "LUPREC" tp:o-PREC)
  (setvar "MEASUREMENT" 1))

(defun tp:origin (pt / ss)
  (command "_.UCS" "_W") (tp:end-cmd)
  (if (and pt (> (distance (list (car pt) (cadr pt)) '(0.0 0.0)) 1e-9) (setq ss (tp:model-ss)))
    (progn
      (command "_.MOVE" ss "" (list (car pt) (cadr pt) 0.0) '(0.0 0.0 0.0)) (tp:end-cmd)
      (tp:note "Objets déplacés vers l'origine" (sslength ss))))
  (setvar "INSBASE" '(0.0 0.0 0.0)))

(defun tp:locked-to-back (saved / locked ss sel i e)
  (foreach l saved (if (/= 0 (logand 4 (cadr l))) (setq locked (cons (strcase (car l)) locked))))
  (if (and locked (setq ss (tp:model-ss)))
    (progn
      (setq sel (ssadd) i 0)
      (repeat (sslength ss)
        (setq e (ssname ss i) i (1+ i))
        (if (member (strcase (tp:dxf 8 (entget e))) locked) (ssadd e sel)))
      (if (> (sslength sel) 0)
        (progn (command "_.DRAWORDER" sel "" "_B") (tp:end-cmd)
               (tp:note "Objets des calques verrouillés mis en arrière-plan" (sslength sel)))))))

;; Liste d'échelles normalisées, compte tenu de l'unité du dessin (papier en mm).
(setq tp:*scales* '(1 2 5 10 20 25 50 100 200 250 500 1000 2000 2500 5000))

(defun tp:scale-names (/ r)
  (foreach p (dictsearch (namedobjdict) "ACAD_SCALELIST")
    (if (= 350 (car p)) (setq r (cons (tp:dxf 300 (entget (cdr p))) r))))
  (reverse r))

(defun tp:scale-list (/ f names n)
  (setq f (tp:unit-factor (getvar "INSUNITS")))
  (if (not f) (setq f 0.001))
  (setq f (/ 0.001 f))                         ; unités du dessin par mm papier
  ;; Liste réinitialisée puis vidée (les échelles utilisées restent), puis échelles normalisées
  (command "_.-SCALELISTEDIT" "_R" "_Y")
  (foreach s (tp:scale-names) (command "_D" s))
  (command "_E") (tp:end-cmd)
  (setq names (mapcar 'strcase (tp:scale-names)) n 0)
  (command "_.-SCALELISTEDIT")
  (foreach s tp:*scales*
    (if (not (member (strcat "1:" (itoa s)) names))
      (progn (command "_A" (strcat "1:" (itoa s)) (strcat "1:" (rtos (* s f) 2 6))) (setq n (1+ n)))))
  (command "_E") (tp:end-cmd)
  (tp:note "Échelles normalisées ajoutées" n))

(defun tp:table-count (/ n d)
  (setq n 0)
  (foreach tb '("BLOCK" "LAYER" "LTYPE" "STYLE" "DIMSTYLE" "APPID")
    (setq d (tblnext tb T))
    (while d (setq n (1+ n) d (tblnext tb))))
  n)

(defun tp:purge (/ before)
  (setq before (tp:table-count))
  (repeat 3 (command "_.-PURGE" "_A" "*" "_N") (tp:end-cmd))
  (command "_.-PURGE" "_R" "*" "_N") (tp:end-cmd)
  (command "_.-PURGE" "_Z") (tp:end-cmd)
  (command "_.-PURGE" "_E") (tp:end-cmd)
  (tp:note "Éléments purgés (blocs, calques, styles)" (- before (tp:table-count))))

;;; --------------------------------------------------------------------------
;;; Traitement complet
;;; --------------------------------------------------------------------------

(setq tp:*sysvars* '("CMDECHO" "OSMODE" "EXPERT" "FILEDIA" "ATTREQ" "HIGHLIGHT"))

(defun tp:vars-save () (setq tp:*saved-vars* (mapcar '(lambda (v) (cons v (getvar v))) tp:*sysvars*)))

(defun tp:vars-restore ()
  (foreach p tp:*saved-vars* (vl-catch-all-apply 'setvar (list (car p) (cdr p))))
  (setq tp:*saved-vars* nil))

;; Lance le traitement décrit par cfg sur le dessin courant ; renvoie les lignes du rapport.
(defun tp:run (cfg / t0 clayer ctab lay0 lines)
  (setq tp:*cfg* cfg tp:*rep* nil tp:*msgs* nil tp:*laymap* nil tp:*convtable* nil tp:*lttable* nil tp:*hidden* nil
        tp:*empty* nil tp:*noflat* 0 tp:*plflat* nil tp:*can-expl* nil tp:*why* nil tp:*t-last* nil)
  (tp:tick "début")
  (tp:set-flags cfg)
  (setq t0 (tp:clock))
  ;; données étendues lues seulement si un traitement en a besoin
  (setq tp:*xd* (if (or tp:o-PROXY tp:o-COTES_DUBLOC) '("*")))
  (tp:vars-save)
  (setvar "CMDECHO" 0) (setvar "OSMODE" 0) (setvar "EXPERT" 5) (setvar "FILEDIA" 0)
  (setvar "ATTREQ" 0) (setvar "HIGHLIGHT" 0)
  (command "_.UNDO" "_BE") (tp:end-cmd)
  (setq clayer (getvar "CLAYER") ctab (getvar "CTAB"))
  ;; Calques : états d'origine, puis tous libérés pendant le traitement
  (setq lay0 (tp:layer-list) tp:*lay0* (if tp:o-LIBERER nil lay0))
  (setq tp:*hidden* (if tp:o-CALQUES_CACHES (tp:hidden-layers lay0)))
  (setq tp:*skip* (if tp:o-LIBERER nil
                    (vl-remove-if '(lambda (n) (member n tp:*hidden*)) (tp:skip-layers lay0))))
  (setq tp:*n-freed* (tp:layers-free))
  (setvar "TILEMODE" 1)
  ;; Tables préparées
  (if (and tp:o-CONV_CALQUES (/= "" tp:o-TABLE_CALQUES))
    (if (findfile tp:o-TABLE_CALQUES)
      (setq tp:*convtable* (tp:conv-table (findfile tp:o-TABLE_CALQUES)))
      (tp:warn (strcat "Table de calques introuvable : " tp:o-TABLE_CALQUES))))
  (if tp:o-TYPESLIGNE
    (foreach p tp:o-TL_TABLE
      (if (tp:ensure-ltype (cdr p))
        (setq tp:*lttable* (cons (cons (strcase (car p)) (cdr p)) tp:*lttable*))
        (tp:warn (strcat "Type de ligne « " (cdr p) " » introuvable : conversion ignorée.")))))
  (if tp:o-STYLES (tp:ensure-style tp:o-STYLE_NOM))
  ;; Traitements actifs (évite les fonctions inutiles dans la boucle des objets)
  (setq tp:*lay-del* (or tp:o-CALQUES_SUPPR tp:o-CALQUES_CACHES tp:*convtable*)
        tp:*lay-ops* (or tp:*lay-del* tp:o-COTES_CALQUE tp:o-HACH_CALQUE)
        tp:*col-ops* (or tp:o-COULEURS (and tp:o-COULEUR_UNIQUE tp:o-CU_ENTITES) tp:o-DUCALQUE tp:o-DUBLOC)
        tp:*lt-ops* (or (and tp:o-TYPESLIGNE tp:*lttable*) tp:o-TL_DUCALQUE tp:o-TL_ECHELLE1)
        tp:*mt-codes* (append (if tp:o-MTEXT tp:*fmt-mtext*)
                              (if tp:o-STYLES '(102 70))
                              (if (or tp:o-DUCALQUE tp:o-COULEUR_UNIQUE) '(67 99)))
        tp:*txt-ops* (or tp:o-STYLES tp:*mt-codes*))
  (if tp:o-COTES_CALQUE (tp:ensure-layer tp:o-NOM_COTES nil nil nil))
  (if tp:o-HACH_CALQUE (tp:ensure-layer tp:o-NOM_HACH nil nil nil))
  (if tp:o-COTES_DUBLOC (tp:dimstyles-byblock))
  ;; Suppressions globales
  (if tp:o-PRESENTATIONS (tp:del-layouts))
  (if tp:o-XREFS
    (progn
      (if (/= "AUCUNE" tp:o-XREF_MODE) (tp:xrefs tp:o-XREF_MODE))
      (if (/= "AUCUNE" tp:o-IMAGE_MODE) (tp:images tp:o-IMAGE_MODE))))
  (if tp:o-BLOCS_VIDES (setq tp:*empty* (tp:empty-blocks)))
  ;; Objets : définitions de blocs, puis espaces objet et papier
  (tp:tick "préparation")
  (tp:block-pass)
  (tp:tick "blocs")
  (if tp:o-BLOCS_VIDES (setq tp:*empty* (tp:empty-blocks)))
  (tp:space-pass)
  (tp:tick "objets")
  (if (> tp:*noflat* 0) (tp:note "Objets non aplatis (plan incliné)" tp:*noflat*))
  ;; Tables
  (tp:layer-table-ops)
  (if (and tp:o-STYLES (/= "" tp:o-POLICE)) (tp:styles-font tp:o-POLICE))
  (if tp:o-GROUPES (tp:groups))
  (if tp:o-PROXY (tp:aec-dicts))
  ;; Géométrie d'ensemble et ordre d'affichage
  (if (and tp:o-ORIGINE (= "COORD" tp:o-ORIG_MODE)) (tp:origin tp:o-ORIG_PT))
  (if tp:o-UNITES (tp:units-apply))
  (if tp:o-HACH_ARRIERE (progn (command "_.HATCHTOBACK") (tp:end-cmd)))
  (if tp:o-VERR_ARRIERE (tp:locked-to-back lay0))
  ;; Finition
  (tp:tick "tables")
  (if tp:o-PURGE (tp:purge))
  (tp:tick "purge")
  (if tp:o-ECHELLES (tp:scale-list))
  (if tp:o-AUDIT (progn (command "_.AUDIT" "_Y") (tp:end-cmd)))
  (tp:tick "audit")
  ;; Calques : états rétablis, sauf si « Libérer » est coché
  (if tp:o-LIBERER
    (tp:note "Calques libérés" tp:*n-freed*)
    (progn
      (tp:layers-restore lay0)
      (if (and (tblsearch "LAYER" clayer) (= 0 (logand 1 (tp:dxf 70 (tblsearch "LAYER" clayer)))))
        (setvar "CLAYER" clayer))))
  (if (and (/= "MODEL" (strcase ctab)) (member ctab (tp:layout-names))) (setvar "CTAB" ctab))
  (setq tp:*lay0* nil)
  (command "_.REGENALL") (tp:end-cmd)
  (command "_.UNDO" "_E") (tp:end-cmd)
  (tp:vars-restore)
  (setq lines (tp:report-lines (/ (- (tp:clock) t0) 1000.0)))
  lines)

;; Horloge en millisecondes.
(defun tp:clock (/ ms)
  (if (setq ms (getvar "MILLISECS")) ms (fix (* 86400000.0 (getvar "DATE")))))

;; Chronométrage des phases (mise au point : (setq tp:*timing* T)).
(defun tp:tick (label / now)
  (if tp:*timing*
    (progn
      (setq now (tp:clock))
      (if tp:*t-last* (tp:note (strcat "ms " label) (- now tp:*t-last*)))
      (setq tp:*t-last* now))))

(defun tp:print-report (lines)
  (foreach l lines (princ (strcat "\n" l)))
  (princ "\n  (U pour tout annuler)"))

;; Lancement depuis une commande : point d'origine demandé si besoin, erreurs gérées.
(defun tp:cmd (cfg / *error* pt)
  (defun *error* (msg)
    (if (not (wcmatch (strcase msg) "*CANCEL*,*QUIT*,*ANNUL*,*ABANDON*"))
      (princ (strcat "\nTraitement de plans : erreur « " msg " » (U pour annuler ce qui a été fait).")))
    (if tp:*lay0* (vl-catch-all-apply 'tp:layers-restore (list tp:*lay0*)))
    (setq tp:*lay0* nil)
    (command-s "_.UNDO" "_E")
    (tp:vars-restore)
    (princ))
  (if (and (tp:cfg-of cfg "ORIGINE") (= "POINT" (tp:cfg-of cfg "ORIG_MODE")))
    (if (setq pt (getpoint "\nPoint à ramener en 0,0 <aucun> : "))
      (setq cfg (tp:cfg-set (tp:cfg-set cfg "ORIG_MODE" "COORD") "ORIG_PT" (trans pt 1 0)))
      (setq cfg (tp:cfg-set cfg "ORIGINE" nil))))
  (tp:print-report (tp:run cfg))
  (princ))

;;; --------------------------------------------------------------------------
;;; Table des calques (export CSV pour Excel)
;;; --------------------------------------------------------------------------

(defun tp:layer-count (name / ss)
  (if (setq ss (ssget "_X" (list (cons 8 (tp:wc-escape name))))) (sslength ss) 0))

(defun tp:csv-cell (s)
  (if (or (vl-string-search ";" s) (vl-string-search "\"" s))
    (strcat "\"" (tp:replace-all "\"\"" "\"" s) "\"")
    s))

;; Table des calques du dessin : la colonne « Calque cible » est à compléter.
(defun tp:export-layers (path / f d lw)
  (if (setq f (open path "w" "utf8"))
    (progn
      (write-char 65279 f)
      (write-line "Calque source;Calque cible;Couleur;Type de ligne;Epaisseur;Objets" f)
      (foreach l (tp:layer-list)
        (if (= 0 (logand 16 (cadr l)))
          (progn
            (setq d (tblsearch "LAYER" (car l)) lw (tp:dxf 370 d))
            (write-line
              (strcat (tp:csv-cell (car l)) ";;" (itoa (abs (caddr l))) ";" (tp:csv-cell (tp:dxf 6 d)) ";"
                      (if (and lw (>= lw 0)) (rtos (/ lw 100.0) 2 2) "")
                      ";" (itoa (tp:layer-count (car l))))
              f))))
      (close f)
      T)))

;;; --------------------------------------------------------------------------
;;; Traitement par lot
;;; --------------------------------------------------------------------------

(defun tp:lsp-path (/ p)
  (cond
    ((setq p (findfile "TraitementPlans.lsp")) p)
    ((and (setq p (getenv "TraitementPlans_Lsp")) (findfile p)) p)
    ((setq p (getfiled "Où se trouve TraitementPlans.lsp ?" "" "lsp" 0))
     (setenv "TraitementPlans_Lsp" p) p)))

;; Date et heure : « 16.10.2026 15:30 ».
(defun tp:now (/ s)
  (setq s (rtos (getvar "CDATE") 2 6))
  (strcat (substr s 7 2) "." (substr s 5 2) "." (substr s 1 4) " " (substr s 10 2) ":" (substr s 12 2)))

(defun tp:log (path lines / f)
  (if (setq f (open path "a" "utf8"))
    (progn (foreach l lines (write-line l f)) (close f))))

;; Appelée par le script de TPLOT dans chaque dessin ouvert.
(defun tp:batch-one (prof outdir logfile / cfg lines name)
  (setq cfg (tp:profile-load prof))
  (if (and (tp:cfg-of cfg "ORIGINE") (= "POINT" (tp:cfg-of cfg "ORIG_MODE")))
    (setq cfg (tp:cfg-set cfg "ORIGINE" nil)))
  (setq lines (tp:run cfg))
  (setq name (strcat (getvar "DWGPREFIX") (getvar "DWGNAME")))
  (tp:log logfile (cons (strcat "== " name) (cdr lines)))
  (setvar "FILEDIA" 0) (setvar "EXPERT" 5)
  (if (and outdir (/= outdir ""))
    (progn
      (vl-mkdir outdir)
      (command "_.SAVEAS" "" (strcat outdir "\\" (getvar "DWGNAME")))
      (while (> (logand 1 (getvar "CMDACTIVE")) 0) (command "_Y")))
    (progn (command "_.QSAVE") (tp:end-cmd)))
  (princ))

(defun tp:ask-profile (/ names s)
  (tp:ensure-profiles)
  (setq names (tp:profile-names))
  (princ "\nProfils : ")
  (foreach n names (princ (strcat "\n  " n)))
  (setq s (getstring T (strcat "\nProfil à utiliser <" (tp:last-profile) "> : ")))
  (cond ((= s "") (tp:last-profile))
        ((member (strcase s) (mapcar 'strcase names))
         (nth (vl-position (strcase s) (mapcar 'strcase names)) names))
        (T (princ (strcat "\nProfil inconnu : " s)) nil)))

(defun c:TPLOT (/ f dir files prof mode outdir scr lsp logfile h)
  (princ "\nTraitement par lot : choisissez un dessin du dossier à traiter.")
  (if (and (setq f (getfiled "Dossier à traiter : choisir un des dessins" (getvar "DWGPREFIX") "dwg" 0))
           (setq prof (tp:ask-profile))
           (setq lsp (tp:lsp-path)))
    (progn
      (setq dir (vl-filename-directory f) files (vl-directory-files dir "*.dwg" 1))
      (initget "Copie Remplacer")
      (setq mode (getkword "\nEnregistrement [Copie dans le sous-dossier « Traité »/Remplacer les fichiers] <Copie> : "))
      (setq outdir (if (= mode "Remplacer") "" (strcat dir "\\Traité")))
      (setq logfile (strcat dir "\\Traitement de plans - rapport.txt"))
      (tp:log logfile (list "" (strcat "Traitement par lot — profil « " prof " » — " (tp:now))))
      (setq scr (vl-filename-mktemp "tplot" nil ".scr"))
      (setq h (open scr "w"))
      (write-line "(setvar \"FILEDIA\" 0)" h)
      (foreach n files
        (write-line "_.OPEN" h)
        (write-line (strcat "\"" dir "\\" n "\"") h)
        (write-line (strcat "(if (not tp:run) (load \"" (vl-string-translate "\\" "/" lsp) "\"))") h)
        (write-line (strcat "(tp:batch-one " (vl-prin1-to-string prof) " " (vl-prin1-to-string outdir) " "
                            (vl-prin1-to-string logfile) ")") h)
        (write-line "_.CLOSE" h))
      (write-line "(setvar \"FILEDIA\" 1)" h)
      (write-line (strcat "(princ \"\\nTraitement par lot terminé : " (itoa (length files))
                          " dessin(s). Rapport : " (vl-string-translate "\\" "/" logfile) "\")") h)
      (close h)
      (princ (strcat "\n" (itoa (length files)) " dessin(s) à traiter. Le lot démarre…"))
      (command "_.SCRIPT" scr)))
  (princ))

;;; --------------------------------------------------------------------------
;;; Boîtes de dialogue
;;; --------------------------------------------------------------------------

(setq tp:*dcl* '(
  "tp_opt : toggle { width = 36; }"
  "tp_btn : button { label = \"...\"; width = 5; fixed_width = true; }"
  "tp_main : dialog {"
  "  label = \"Traitement de plans - Nettoyeur de plan\";"
  "  : row {"
  "    : popup_list { key = \"profil\"; label = \"Profil\"; width = 40; }"
  "    : button { key = \"p_save\"; label = \"Enregistrer\"; fixed_width = true; }"
  "    : button { key = \"p_saveas\"; label = \"Enregistrer sous...\"; fixed_width = true; }"
  "    : button { key = \"p_del\"; label = \"Supprimer\"; fixed_width = true; }"
  "  }"
  "  : row {"
  "    : column {"
  "      : boxed_column {"
  "        label = \"Préparation\";"
  "        : tp_opt { key = \"LIBERER\"; label = \"Libérer tous les calques\"; }"
  "        : row { : tp_opt { key = \"UNITES\"; label = \"Unités du dessin et conversion\"; } : tp_btn { key = \"b_UNITES\"; } }"
  "        : row { : tp_opt { key = \"ORIGINE\"; label = \"Ramener un point en 0,0\"; } : tp_btn { key = \"b_ORIGINE\"; } }"
  "        : tp_opt { key = \"APLATIR\"; label = \"Tout aplatir (Z = 0, épaisseur 0)\"; }"
  "      }"
  "      : boxed_column {"
  "        label = \"Suppressions\";"
  "        : tp_opt { key = \"PRESENTATIONS\"; label = \"Présentations\"; }"
  "        : tp_opt { key = \"TEXTES\"; label = \"Textes vides et espaces superflus\"; }"
  "        : row { : tp_opt { key = \"PETITS\"; label = \"Objets de longueur nulle ou trop petits\"; } : tp_btn { key = \"b_PETITS\"; } }"
  "        : tp_opt { key = \"MASQUES\"; label = \"Masques (wipeouts)\"; }"
  "        : tp_opt { key = \"HACH_SOLIDES\"; label = \"Hachures pleines (SOLID)\"; }"
  "        : tp_opt { key = \"SOLIDES2D\"; label = \"Solides 2D\"; }"
  "        : tp_opt { key = \"PROXY\"; label = \"Objets AEC et proxy\"; }"
  "        : row { : tp_opt { key = \"XREFS\"; label = \"Xrefs et images introuvables\"; } : tp_btn { key = \"b_XREFS\"; } }"
  "        : tp_opt { key = \"GROUPES\"; label = \"Groupes vides\"; }"
  "        : tp_opt { key = \"BLOCS_VIDES\"; label = \"Blocs vides\"; }"
  "        : row { : tp_opt { key = \"CALQUES_SUPPR\"; label = \"Calques à supprimer (avec leurs objets)\"; } : tp_btn { key = \"b_CALQUES_SUPPR\"; } }"
  "        : tp_opt { key = \"CALQUES_CACHES\"; label = \"Calques gelés et désactivés (avec leurs objets)\"; }"
  "      }"
  "    }"
  "    : column {"
  "      : boxed_column {"
  "        label = \"Normalisation\";"
  "        : tp_opt { key = \"DUCALQUE\"; label = \"Couleurs DuCalque (objets)\"; }"
  "        : tp_opt { key = \"DUBLOC\"; label = \"Couleurs DuBloc (composants des blocs)\"; }"
  "        : tp_opt { key = \"COTES_DUBLOC\"; label = \"Couleurs DuBloc (cotes)\"; }"
  "        : tp_opt { key = \"TL_DUCALQUE\"; label = \"Types de ligne DuCalque\"; }"
  "        : tp_opt { key = \"EP_DUCALQUE\"; label = \"Épaisseurs de ligne DuCalque\"; }"
  "        : row { : tp_opt { key = \"COULEURS\"; label = \"Convertir les couleurs\"; } : tp_btn { key = \"b_COULEURS\"; } }"
  "        : row { : tp_opt { key = \"COULEUR_UNIQUE\"; label = \"Couleur unique\"; } : tp_btn { key = \"b_COULEUR_UNIQUE\"; } }"
  "        : row { : tp_opt { key = \"TYPESLIGNE\"; label = \"Convertir les types de ligne\"; } : tp_btn { key = \"b_TYPESLIGNE\"; } }"
  "        : row { : tp_opt { key = \"STYLES\"; label = \"Fusionner les styles de texte\"; } : tp_btn { key = \"b_STYLES\"; } }"
  "        : tp_opt { key = \"MTEXT\"; label = \"Textes multilignes sans mise en forme\"; }"
  "        : row { : tp_opt { key = \"COTES_CALQUE\"; label = \"Cotes sur un calque unique\"; } : tp_btn { key = \"b_COTES_CALQUE\"; } }"
  "        : tp_opt { key = \"HACH_CALQUE\"; label = \"Hachures sur un calque unique\"; }"
  "        : tp_opt { key = \"HACH_ARRIERE\"; label = \"Hachures en arrière-plan\"; }"
  "        : tp_opt { key = \"VERR_ARRIERE\"; label = \"Calques verrouillés en arrière-plan\"; }"
  "        : tp_opt { key = \"NEXPL\"; label = \"Décomposer les blocs imbriqués\"; }"
  "      }"
  "      : boxed_column {"
  "        label = \"Calques et finition\";"
  "        : row { : tp_opt { key = \"CONV_CALQUES\"; label = \"Convertir les calques (table CSV)\"; } : tp_btn { key = \"b_CONV_CALQUES\"; } }"
  "        : tp_opt { key = \"PURGE\"; label = \"Tout purger (éléments imbriqués)\"; }"
  "        : tp_opt { key = \"ECHELLES\"; label = \"Liste d'échelles normalisée\"; }"
  "        : tp_opt { key = \"AUDIT\"; label = \"Contrôler et réparer (AUDIT)\"; }"
  "      }"
  "    }"
  "  }"
  "  : boxed_row {"
  "    label = \"Traiter aussi les objets des calques\";"
  "    : toggle { key = \"VERROUILLES\"; label = \"verrouillés\"; }"
  "    : toggle { key = \"GELES\"; label = \"gelés\"; }"
  "    : toggle { key = \"DESACTIVES\"; label = \"désactivés\"; }"
  "  }"
  "  errtile;"
  "  : row {"
  "    : button { key = \"tout\"; label = \"Tout cocher\"; fixed_width = true; }"
  "    : button { key = \"rien\"; label = \"Tout décocher\"; fixed_width = true; }"
  "    : button { key = \"aide\"; label = \"Aide\"; fixed_width = true; }"
  "    : spacer { width = 6; }"
  "    : button { key = \"accept\"; label = \"Lancer\"; is_default = true; fixed_width = true; width = 14; }"
  "    : button { key = \"cancel\"; label = \"Annuler\"; is_cancel = true; fixed_width = true; width = 14; }"
  "  }"
  "}"
  "tp_name : dialog {"
  "  label = \"Traitement de plans\";"
  "  : text { key = \"titre\"; width = 40; }"
  "  : edit_box { key = \"nom\"; edit_width = 40; edit_limit = 80; }"
  "  ok_cancel;"
  "}"
  "tp_confirm : dialog {"
  "  label = \"Traitement de plans\";"
  "  : text { key = \"msg\"; width = 50; }"
  "  ok_cancel;"
  "}"
  "tp_units : dialog {"
  "  label = \"Unités du dessin\";"
  "  : text { key = \"actuelle\"; width = 50; }"
  "  : popup_list { key = \"UNITE\"; label = \"Unité du dessin\"; edit_width = 24; }"
  "  : popup_list { key = \"PREC\"; label = \"Décimales affichées\"; edit_width = 24; }"
  "  : boxed_column {"
  "    label = \"Mise à l'échelle\";"
  "    : toggle { key = \"CONVUNITE\"; label = \"Mettre le dessin à l'échelle depuis l'unité :\"; }"
  "    : popup_list { key = \"UNITE_SRC\"; edit_width = 40; }"
  "    : text { label = \"Exemple : base en centimètres et unité mm = dessin agrandi 10 fois.\"; }"
  "  }"
  "  : row {"
  "    : button { key = \"mesurer\"; label = \"Mesurer une distance <\"; fixed_width = true; }"
  "    : text { key = \"mesure\"; width = 40; }"
  "  }"
  "  ok_cancel;"
  "}"
  "tp_origin : dialog {"
  "  label = \"Ramener un point en 0,0\";"
  "  : radio_column {"
  "    key = \"ORIG_MODE\";"
  "    : radio_button { key = \"POINT\"; label = \"Désigner le point au lancement\"; }"
  "    : radio_button { key = \"COORD\"; label = \"Utiliser les coordonnées ci-dessous (traitement par lot)\"; }"
  "  }"
  "  : row {"
  "    : edit_box { key = \"X\"; label = \"X\"; edit_width = 16; }"
  "    : edit_box { key = \"Y\"; label = \"Y\"; edit_width = 16; }"
  "  }"
  "  : button { key = \"pick\"; label = \"Désigner maintenant <\"; fixed_width = true; }"
  "  ok_cancel;"
  "}"
  "tp_small : dialog {"
  "  label = \"Objets trop petits\";"
  "  : text { label = \"Les lignes, arcs, cercles, polylignes, ellipses et splines plus courts\"; }"
  "  : text { label = \"que cette longueur sont supprimés (0 = seulement les longueurs nulles).\"; }"
  "  : edit_box { key = \"TOL\"; label = \"Longueur minimale (unités du dessin)\"; edit_width = 14; }"
  "  ok_cancel;"
  "}"
  "tp_xrefs : dialog {"
  "  label = \"Xrefs et images\";"
  "  : boxed_radio_column {"
  "    key = \"XREF_MODE\";"
  "    label = \"Références externes (DWG)\";"
  "    : radio_button { key = \"X_INTROUVABLES\"; label = \"Détacher les xrefs introuvables\"; }"
  "    : radio_button { key = \"X_NONREF\"; label = \"Détacher les introuvables et les non référencées\"; }"
  "    : radio_button { key = \"X_TOUTES\"; label = \"Détacher toutes les xrefs\"; }"
  "    : radio_button { key = \"X_LIER\"; label = \"Lier (insérer) les xrefs trouvées, détacher les introuvables\"; }"
  "    : radio_button { key = \"X_AUCUNE\"; label = \"Ne pas toucher aux xrefs\"; }"
  "  }"
  "  : boxed_radio_column {"
  "    key = \"IMAGE_MODE\";"
  "    label = \"Images raster\";"
  "    : radio_button { key = \"I_INTROUVABLES\"; label = \"Détacher les images introuvables\"; }"
  "    : radio_button { key = \"I_NONREF\"; label = \"Détacher les introuvables et les non référencées\"; }"
  "    : radio_button { key = \"I_TOUTES\"; label = \"Détacher toutes les images\"; }"
  "    : radio_button { key = \"I_AUCUNE\"; label = \"Ne pas toucher aux images\"; }"
  "  }"
  "  ok_cancel;"
  "}"
  "tp_laydel : dialog {"
  "  label = \"Calques à supprimer\";"
  "  : row {"
  "    : column {"
  "      : list_box { key = \"filtres\"; label = \"Calques ou motifs supprimés (* et ? autorisés)\"; width = 40; height = 14; }"
  "      : row {"
  "        : edit_box { key = \"motif\"; edit_width = 24; }"
  "        : button { key = \"ajouter_motif\"; label = \"Ajouter\"; fixed_width = true; }"
  "      }"
  "      : button { key = \"retirer\"; label = \"Retirer le motif sélectionné\"; fixed_width = true; }"
  "    }"
  "    : column {"
  "      : list_box { key = \"calques\"; label = \"Calques du dessin\"; width = 40; height = 14; multiple_select = true; }"
  "      : button { key = \"ajouter_calques\"; label = \"<< Ajouter les calques sélectionnés\"; fixed_width = true; }"
  "    }"
  "  }"
  "  : text { label = \"Les objets de ces calques sont supprimés partout, blocs compris (sauf calques 0 et DEFPOINTS).\"; }"
  "  ok_cancel;"
  "}"
  "tp_colors : dialog {"
  "  label = \"Convertir les couleurs\";"
  "  : list_box { key = \"table\"; label = \"Conversions (source -> cible)\"; width = 40; height = 10; }"
  "  : row {"
  "    : edit_box { key = \"src\"; label = \"Source\"; edit_width = 5; }"
  "    : tp_btn { key = \"src_ch\"; }"
  "    : edit_box { key = \"dst\"; label = \"Cible\"; edit_width = 5; }"
  "    : tp_btn { key = \"dst_ch\"; }"
  "  }"
  "  : row {"
  "    : button { key = \"ajouter\"; label = \"Ajouter\"; fixed_width = true; }"
  "    : button { key = \"retirer\"; label = \"Retirer\"; fixed_width = true; }"
  "  }"
  "  : text { label = \"Source 256 = toutes les couleurs.\"; }"
  "  : boxed_column {"
  "    label = \"Appliquer\";"
  "    : toggle { key = \"COUL_CALQUES\"; label = \"aux couleurs des calques\"; }"
  "    : toggle { key = \"COUL_FORCEES\"; label = \"aux objets en couleur forcée\"; }"
  "    : toggle { key = \"COUL_DUCALQUE\"; label = \"aux objets DuCalque (couleur forcée d'après leur calque)\"; }"
  "  }"
  "  errtile;"
  "  ok_cancel;"
  "}"
  "tp_single : dialog {"
  "  label = \"Couleur unique\";"
  "  : row {"
  "    : edit_box { key = \"COUL_UNIQUE\"; label = \"Couleur\"; edit_width = 5; }"
  "    : button { key = \"choisir\"; label = \"Choisir...\"; fixed_width = true; }"
  "  }"
  "  : toggle { key = \"CU_CALQUES\"; label = \"Appliquer à tous les calques\"; }"
  "  : toggle { key = \"CU_ENTITES\"; label = \"Forcer la couleur de tous les objets (composants des blocs DuBloc)\"; }"
  "  errtile;"
  "  ok_cancel;"
  "}"
  "tp_ltypes : dialog {"
  "  label = \"Convertir les types de ligne\";"
  "  : list_box { key = \"table\"; label = \"Conversions (source -> cible)\"; width = 50; height = 10; }"
  "  : row {"
  "    : popup_list { key = \"src\"; label = \"Source\"; edit_width = 20; }"
  "    : edit_box { key = \"dst\"; label = \"Cible\"; edit_width = 16; }"
  "  }"
  "  : row {"
  "    : button { key = \"ajouter\"; label = \"Ajouter\"; fixed_width = true; }"
  "    : button { key = \"retirer\"; label = \"Retirer\"; fixed_width = true; }"
  "  }"
  "  : row {"
  "    : edit_box { key = \"FICHIER_LIN\"; label = \"Fichier .lin des types cibles\"; edit_width = 30; }"
  "    : button { key = \"parcourir\"; label = \"Parcourir...\"; fixed_width = true; }"
  "  }"
  "  : toggle { key = \"TL_ECHELLE1\"; label = \"Échelle de type de ligne 1 pour tous les objets\"; }"
  "  ok_cancel;"
  "}"
  "tp_styles : dialog {"
  "  label = \"Fusionner les styles de texte\";"
  "  : list_box { key = \"styles\"; label = \"Styles du dessin\"; width = 40; height = 8; }"
  "  : edit_box { key = \"STYLE_NOM\"; label = \"Style attribué à tous les textes\"; edit_width = 24; }"
  "  : edit_box { key = \"POLICE\"; label = \"Police de tous les styles (vide = inchangée)\"; edit_width = 24; }"
  "  : text { label = \"Exemples de police : arial.ttf, isocp.shx, romans.shx\"; }"
  "  errtile;"
  "  ok_cancel;"
  "}"
  "tp_laynames : dialog {"
  "  label = \"Calques des cotes et des hachures\";"
  "  : edit_box { key = \"NOM_COTES\"; label = \"Calque des cotes\"; edit_width = 36; }"
  "  : edit_box { key = \"NOM_HACH\"; label = \"Calque des hachures\"; edit_width = 36; }"
  "  errtile;"
  "  ok_cancel;"
  "}"
  "tp_conv : dialog {"
  "  label = \"Convertir les calques\";"
  "  : text { label = \"Table CSV (séparateur ;) : Calque source;Calque cible;Couleur;Type de ligne;Epaisseur\"; }"
  "  : text { label = \"* et ? autorisés dans la source ; cible vide = inchangé ; SUPPRIMER = objets supprimés.\"; }"
  "  : row {"
  "    : edit_box { key = \"TABLE_CALQUES\"; label = \"Table\"; edit_width = 50; edit_limit = 260; }"
  "    : button { key = \"parcourir\"; label = \"Parcourir...\"; fixed_width = true; }"
  "  }"
  "  : button { key = \"creer\"; label = \"Créer la table à partir des calques de ce dessin...\"; fixed_width = true; }"
  "  errtile;"
  "  ok_cancel;"
  "}"))

(defun tp:dcl-file (/ f)
  (if (not (and tp:*dclfile* (findfile tp:*dclfile*)))
    (progn
      (setq tp:*dclfile* (vl-filename-mktemp "tp" nil ".dcl") f (open tp:*dclfile* "w"))
      (foreach l tp:*dcl* (write-line l f))
      (close f)))
  tp:*dclfile*)

(defun tp:dlg (k) (cdr (assoc k tp:*dlg*)))
(defun tp:dlg-set (k v) (setq tp:*dlg* (tp:cfg-set tp:*dlg* k v)))
(defun tp:b (v) (if v "1" "0"))
(defun tp:fill-list (key items) (start_list key) (mapcar 'add_list items) (end_list))

(setq tp:*globals* '("VERROUILLES" "GELES" "DESACTIVES"))

(defun tp:main-tiles ()
  (foreach k (append tp:*ops* tp:*globals*) (set_tile k (tp:b (tp:dlg k)))))

(defun tp:main-init ()
  (tp:fill-list "profil" tp:*profiles*)
  (if (member tp:*pname* tp:*profiles*) (set_tile "profil" (itoa (vl-position tp:*pname* tp:*profiles*))))
  (tp:main-tiles)
  (foreach k (append tp:*ops* tp:*globals*) (action_tile k "(tp:dlg-set $key (= $value \"1\"))"))
  (action_tile "profil" "(tp:dlg-profile (atoi $value))")
  (action_tile "p_save" "(tp:dlg-save)")
  (action_tile "p_saveas" "(tp:dlg-saveas)")
  (action_tile "p_del" "(tp:dlg-delete)")
  (action_tile "b_UNITES" "(tp:sub-units)")
  (action_tile "b_ORIGINE" "(tp:sub-origin)")
  (action_tile "b_PETITS" "(tp:sub-small)")
  (action_tile "b_XREFS" "(tp:sub-xrefs)")
  (action_tile "b_CALQUES_SUPPR" "(tp:sub-laydel)")
  (action_tile "b_COULEURS" "(tp:sub-colors)")
  (action_tile "b_COULEUR_UNIQUE" "(tp:sub-single)")
  (action_tile "b_TYPESLIGNE" "(tp:sub-ltypes)")
  (action_tile "b_STYLES" "(tp:sub-styles)")
  (action_tile "b_COTES_CALQUE" "(tp:sub-laynames)")
  (action_tile "b_CONV_CALQUES" "(tp:sub-conv)")
  (action_tile "tout" "(tp:dlg-all T)")
  (action_tile "rien" "(tp:dlg-all nil)")
  (action_tile "aide" "(tp:help)")
  (action_tile "accept" "(done_dialog 1)")
  (action_tile "cancel" "(done_dialog 0)"))

(defun tp:dlg-all (v)
  (foreach k tp:*ops* (tp:dlg-set k v))
  (tp:main-tiles))

(defun tp:dlg-profile (i)
  (setq tp:*pname* (nth i tp:*profiles*) tp:*dlg* (tp:profile-load tp:*pname*))
  (tp:main-tiles))

(defun tp:dlg-save ()
  (if (tp:profile-write tp:*pname* tp:*dlg*)
    (set_tile "error" (strcat "Profil « " tp:*pname* " » enregistré."))
    (set_tile "error" "Impossible d'écrire le profil.")))

(defun tp:ask-name (title default / id st name)
  (setq id (load_dialog (tp:dcl-file)))
  (if (new_dialog "tp_name" id)
    (progn
      (set_tile "titre" title)
      (set_tile "nom" default)
      (mode_tile "nom" 2)
      (action_tile "accept" "(setq name (get_tile \"nom\")) (done_dialog 1)")
      (setq st (start_dialog))))
  (unload_dialog id)
  (if (and (= st 1) name) (tp:trim name)))

(defun tp:dlg-saveas (/ n)
  (setq n (tp:ask-name "Nom du nouveau profil :" ""))
  (cond
    ((or (null n) (= n "")))
    ((wcmatch n "*[\\/:`*?\"<>|]*") (set_tile "error" "Nom de profil invalide (\\ / : * ? \" < > | interdits)."))
    (T
     (tp:profile-write n tp:*dlg*)
     (setq tp:*profiles* (tp:profile-names) tp:*pname* n)
     (tp:fill-list "profil" tp:*profiles*)
     (set_tile "profil" (itoa (vl-position n tp:*profiles*)))
     (set_tile "error" (strcat "Profil « " n " » enregistré.")))))

(defun tp:confirm (msg / id st)
  (setq id (load_dialog (tp:dcl-file)))
  (if (new_dialog "tp_confirm" id)
    (progn (set_tile "msg" msg) (setq st (start_dialog))))
  (unload_dialog id)
  (= st 1))

(defun tp:dlg-delete ()
  (cond
    ((<= (length tp:*profiles*) 1) (set_tile "error" "Le dernier profil ne peut pas être supprimé."))
    ((tp:confirm (strcat "Supprimer le profil « " tp:*pname* " » ?"))
     (vl-file-delete (tp:profile-file tp:*pname*))
     (setq tp:*profiles* (tp:profile-names) tp:*pname* (car tp:*profiles*) tp:*dlg* (tp:profile-load tp:*pname*))
     (tp:fill-list "profil" tp:*profiles*)
     (set_tile "profil" "0")
     (tp:main-tiles))))

;;; Sous-dialogues des paramètres

(defun tp:sub-open (name / id)
  (setq id (load_dialog (tp:dcl-file)))
  (if (new_dialog name id) id (progn (unload_dialog id) nil)))

(defun tp:unit-index (u) (cond ((vl-position u (mapcar 'car tp:*units*))) (0)))

;; Dialogue des unités ; renvoie 6 si l'utilisateur veut mesurer une distance.
(defun tp:units-dialog (/ id st)
  (if (setq id (tp:sub-open "tp_units"))
    (progn
      (tp:fill-list "UNITE" (mapcar 'cadr tp:*units*))
      (set_tile "UNITE" (itoa (tp:unit-index (tp:dlg "UNITE"))))
      (tp:fill-list "PREC" '("0" "1" "2" "3" "4" "5" "6" "7" "8"))
      (set_tile "PREC" (itoa (tp:dlg "PREC")))
      (set_tile "CONVUNITE" (tp:b (tp:dlg "CONVUNITE")))
      (tp:fill-list "UNITE_SRC" (cons "Automatique (unité enregistrée dans le dessin)" (mapcar 'cadr tp:*units*)))
      (set_tile "UNITE_SRC" (itoa (if (= 0 (tp:dlg "UNITE_SRC")) 0 (1+ (tp:unit-index (tp:dlg "UNITE_SRC"))))))
      (set_tile "actuelle" (strcat "Unité enregistrée dans ce dessin : "
                                   (cond ((cadr (assoc (getvar "INSUNITS") tp:*units*))) ("aucune"))))
      (if tp:*mesure*
        (set_tile "mesure" (strcat "Distance mesurée : " (rtos tp:*mesure* 2 4) " unités du dessin")))
      (action_tile "accept"
        (strcat "(tp:dlg-set \"UNITE\" (car (nth (atoi (get_tile \"UNITE\")) tp:*units*)))"
                "(tp:dlg-set \"PREC\" (atoi (get_tile \"PREC\")))"
                "(tp:dlg-set \"CONVUNITE\" (= \"1\" (get_tile \"CONVUNITE\")))"
                "(tp:dlg-set \"UNITE_SRC\" (if (= \"0\" (get_tile \"UNITE_SRC\")) 0 (car (nth (1- (atoi (get_tile \"UNITE_SRC\"))) tp:*units*))))"
                "(done_dialog 1)"))
      (action_tile "mesurer" "(done_dialog 6)")
      (setq st (start_dialog))
      (unload_dialog id)
      st)))

;; Depuis le dialogue principal : une mesure ferme les deux dialogues (reprise dans tp:dialog).
(defun tp:sub-units () (if (= 6 (tp:units-dialog)) (done_dialog 6)))

;; Mesure d'une distance, puis dialogue des unités rouvert seul (tant qu'on remesure).
(defun tp:units-measure (/ d)
  (if (setq d (getdist "\nMesurer une distance : premier point : ")) (setq tp:*mesure* d))
  (if (= 6 (tp:units-dialog)) (tp:units-measure)))

(defun tp:sub-origin (/ id st)
  (if (setq id (tp:sub-open "tp_origin"))
    (progn
      (set_tile "ORIG_MODE" (if (= "COORD" (tp:dlg "ORIG_MODE")) "COORD" "POINT"))
      (set_tile "X" (rtos (car (tp:dlg "ORIG_PT")) 2 4))
      (set_tile "Y" (rtos (cadr (tp:dlg "ORIG_PT")) 2 4))
      (action_tile "accept"
        (strcat "(tp:dlg-set \"ORIG_MODE\" (get_tile \"ORIG_MODE\"))"
                "(tp:dlg-set \"ORIG_PT\" (list (cond ((tp:num (get_tile \"X\"))) (0.0)) (cond ((tp:num (get_tile \"Y\"))) (0.0)) 0.0))"
                "(done_dialog 1)"))
      (action_tile "pick" "(done_dialog 5)")
      (setq st (start_dialog))
      (unload_dialog id)
      (if (= st 5) (done_dialog 5)))))

(defun tp:sub-small (/ id)
  (if (setq id (tp:sub-open "tp_small"))
    (progn
      (set_tile "TOL" (rtos (tp:dlg "TOL") 2 6))
      (action_tile "accept" "(tp:dlg-set \"TOL\" (cond ((tp:num (get_tile \"TOL\"))) (0.0))) (done_dialog 1)")
      (start_dialog)
      (unload_dialog id))))

(defun tp:sub-xrefs (/ id)
  (if (setq id (tp:sub-open "tp_xrefs"))
    (progn
      (set_tile "XREF_MODE" (strcat "X_" (tp:dlg "XREF_MODE")))
      (set_tile "IMAGE_MODE" (strcat "I_" (tp:dlg "IMAGE_MODE")))
      (action_tile "accept"
        (strcat "(tp:dlg-set \"XREF_MODE\" (substr (get_tile \"XREF_MODE\") 3))"
                "(tp:dlg-set \"IMAGE_MODE\" (substr (get_tile \"IMAGE_MODE\") 3))"
                "(done_dialog 1)"))
      (start_dialog)
      (unload_dialog id))))

;; Liste éditable de chaînes (motifs de calques).
(defun tp:laydel-refresh () (tp:fill-list "filtres" tp:*tmp*))

(defun tp:laydel-add-selected (/ idx)
  (foreach i (read (strcat "(" (get_tile "calques") ")"))
    (setq idx (tp:wc-escape (nth i tp:*laynames*)))
    (if (not (member idx tp:*tmp*)) (setq tp:*tmp* (append tp:*tmp* (list idx)))))
  (tp:laydel-refresh))

(defun tp:sub-laydel (/ id)
  (if (setq id (tp:sub-open "tp_laydel"))
    (progn
      (setq tp:*tmp* (tp:dlg "CALQUES_FILTRE")
            tp:*laynames* (acad_strlsort (mapcar 'car (vl-remove-if '(lambda (l) (/= 0 (logand 16 (cadr l)))) (tp:layer-list)))))
      (tp:laydel-refresh)
      (tp:fill-list "calques" tp:*laynames*)
      (action_tile "ajouter_motif"
        "(if (/= \"\" (tp:trim (get_tile \"motif\"))) (progn (setq tp:*tmp* (append tp:*tmp* (list (tp:trim (get_tile \"motif\"))))) (set_tile \"motif\" \"\") (tp:laydel-refresh)))")
      (action_tile "ajouter_calques" "(tp:laydel-add-selected)")
      (action_tile "retirer"
        "(if (/= \"\" (get_tile \"filtres\")) (progn (setq tp:*tmp* (vl-remove (nth (atoi (get_tile \"filtres\")) tp:*tmp*) tp:*tmp*)) (tp:laydel-refresh)))")
      (action_tile "accept" "(tp:dlg-set \"CALQUES_FILTRE\" tp:*tmp*) (done_dialog 1)")
      (start_dialog)
      (unload_dialog id))))

(defun tp:color-text (c) (if (= c 256) "toutes" (itoa c)))

(defun tp:colors-refresh ()
  (tp:fill-list "table" (mapcar '(lambda (p) (strcat (tp:color-text (car p)) "  ->  " (itoa (cdr p)))) tp:*tmp*)))

(defun tp:pick-color (key / c)
  (if (setq c (acad_colordlg (cond ((tp:num (get_tile key))) (7)) nil)) (set_tile key (itoa c))))

(defun tp:colors-add (/ s d)
  (setq s (tp:num (get_tile "src")) d (tp:num (get_tile "dst")))
  (if (and s d (<= 1 s 256) (<= 1 d 255))
    (progn
      (setq tp:*tmp* (append (vl-remove (assoc (fix s) tp:*tmp*) tp:*tmp*) (list (cons (fix s) (fix d)))))
      (tp:colors-refresh)
      (set_tile "error" ""))
    (set_tile "error" "Couleurs : source de 1 à 256 (256 = toutes), cible de 1 à 255.")))

(defun tp:sub-colors (/ id)
  (if (setq id (tp:sub-open "tp_colors"))
    (progn
      (setq tp:*tmp* (tp:dlg "COUL_TABLE"))
      (tp:colors-refresh)
      (foreach k '("COUL_CALQUES" "COUL_FORCEES" "COUL_DUCALQUE") (set_tile k (tp:b (tp:dlg k))))
      (action_tile "src_ch" "(tp:pick-color \"src\")")
      (action_tile "dst_ch" "(tp:pick-color \"dst\")")
      (action_tile "ajouter" "(tp:colors-add)")
      (action_tile "retirer"
        "(if (/= \"\" (get_tile \"table\")) (progn (setq tp:*tmp* (vl-remove (nth (atoi (get_tile \"table\")) tp:*tmp*) tp:*tmp*)) (tp:colors-refresh)))")
      (action_tile "accept"
        (strcat "(tp:dlg-set \"COUL_TABLE\" tp:*tmp*)"
                "(foreach k '(\"COUL_CALQUES\" \"COUL_FORCEES\" \"COUL_DUCALQUE\") (tp:dlg-set k (= \"1\" (get_tile k))))"
                "(done_dialog 1)"))
      (start_dialog)
      (unload_dialog id))))

(defun tp:sub-single (/ id)
  (if (setq id (tp:sub-open "tp_single"))
    (progn
      (set_tile "COUL_UNIQUE" (itoa (tp:dlg "COUL_UNIQUE")))
      (set_tile "CU_CALQUES" (tp:b (tp:dlg "CU_CALQUES")))
      (set_tile "CU_ENTITES" (tp:b (tp:dlg "CU_ENTITES")))
      (action_tile "choisir" "(tp:pick-color \"COUL_UNIQUE\")")
      (action_tile "accept"
        (strcat "(if (and (tp:num (get_tile \"COUL_UNIQUE\")) (<= 1 (tp:num (get_tile \"COUL_UNIQUE\")) 255))"
                " (progn (tp:dlg-set \"COUL_UNIQUE\" (fix (tp:num (get_tile \"COUL_UNIQUE\"))))"
                " (tp:dlg-set \"CU_CALQUES\" (= \"1\" (get_tile \"CU_CALQUES\")))"
                " (tp:dlg-set \"CU_ENTITES\" (= \"1\" (get_tile \"CU_ENTITES\")))"
                " (done_dialog 1))"
                " (set_tile \"error\" \"Couleur de 1 à 255.\"))"))
      (start_dialog)
      (unload_dialog id))))

(defun tp:ltypes-refresh ()
  (tp:fill-list "table" (mapcar '(lambda (p) (strcat (car p) "  ->  " (cdr p))) tp:*tmp*)))

(defun tp:table-names (tb / d r)
  (setq d (tblnext tb T))
  (while d
    (if (= 0 (logand 16 (tp:dxf 70 d))) (setq r (cons (tp:dxf 2 d) r)))
    (setq d (tblnext tb)))
  (acad_strlsort r))

(defun tp:sub-ltypes (/ id)
  (if (setq id (tp:sub-open "tp_ltypes"))
    (progn
      (setq tp:*tmp* (tp:dlg "TL_TABLE")
            tp:*laynames* (vl-remove-if '(lambda (n) (member (strcase n) '("BYLAYER" "BYBLOCK"))) (tp:table-names "LTYPE")))
      (tp:ltypes-refresh)
      (tp:fill-list "src" tp:*laynames*)
      (set_tile "FICHIER_LIN" (tp:dlg "FICHIER_LIN"))
      (set_tile "TL_ECHELLE1" (tp:b (tp:dlg "TL_ECHELLE1")))
      (action_tile "ajouter"
        (strcat "(if (and (/= \"\" (get_tile \"src\")) (/= \"\" (tp:trim (get_tile \"dst\"))))"
                " (progn (setq tp:*tmp* (append (vl-remove (assoc (nth (atoi (get_tile \"src\")) tp:*laynames*) tp:*tmp*) tp:*tmp*)"
                " (list (cons (nth (atoi (get_tile \"src\")) tp:*laynames*) (tp:trim (get_tile \"dst\")))))) (tp:ltypes-refresh)))"))
      (action_tile "retirer"
        "(if (/= \"\" (get_tile \"table\")) (progn (setq tp:*tmp* (vl-remove (nth (atoi (get_tile \"table\")) tp:*tmp*) tp:*tmp*)) (tp:ltypes-refresh)))")
      (action_tile "parcourir"
        "(if (setq tp:*f* (getfiled \"Fichier de types de ligne\" \"\" \"lin\" 0)) (set_tile \"FICHIER_LIN\" tp:*f*))")
      (action_tile "accept"
        (strcat "(tp:dlg-set \"TL_TABLE\" tp:*tmp*)"
                "(tp:dlg-set \"FICHIER_LIN\" (get_tile \"FICHIER_LIN\"))"
                "(tp:dlg-set \"TL_ECHELLE1\" (= \"1\" (get_tile \"TL_ECHELLE1\")))"
                "(done_dialog 1)"))
      (start_dialog)
      (unload_dialog id))))

(defun tp:sub-styles (/ id)
  (if (setq id (tp:sub-open "tp_styles"))
    (progn
      (setq tp:*laynames* (tp:table-names "STYLE"))
      (tp:fill-list "styles" tp:*laynames*)
      (set_tile "STYLE_NOM" (tp:dlg "STYLE_NOM"))
      (set_tile "POLICE" (tp:dlg "POLICE"))
      (action_tile "styles" "(set_tile \"STYLE_NOM\" (nth (atoi $value) tp:*laynames*))")
      (action_tile "accept"
        (strcat "(if (snvalid (tp:trim (get_tile \"STYLE_NOM\")))"
                " (progn (tp:dlg-set \"STYLE_NOM\" (tp:trim (get_tile \"STYLE_NOM\")))"
                " (tp:dlg-set \"POLICE\" (tp:trim (get_tile \"POLICE\"))) (done_dialog 1))"
                " (set_tile \"error\" \"Nom de style invalide.\"))"))
      (start_dialog)
      (unload_dialog id))))

(defun tp:sub-laynames (/ id)
  (if (setq id (tp:sub-open "tp_laynames"))
    (progn
      (set_tile "NOM_COTES" (tp:dlg "NOM_COTES"))
      (set_tile "NOM_HACH" (tp:dlg "NOM_HACH"))
      (action_tile "accept"
        (strcat "(if (and (snvalid (tp:trim (get_tile \"NOM_COTES\"))) (snvalid (tp:trim (get_tile \"NOM_HACH\"))))"
                " (progn (tp:dlg-set \"NOM_COTES\" (tp:trim (get_tile \"NOM_COTES\")))"
                " (tp:dlg-set \"NOM_HACH\" (tp:trim (get_tile \"NOM_HACH\"))) (done_dialog 1))"
                " (set_tile \"error\" \"Nom de calque invalide.\"))"))
      (start_dialog)
      (unload_dialog id))))

(defun tp:conv-browse (/ f)
  (if (setq f (getfiled "Table de conversion des calques" (get_tile "TABLE_CALQUES") "csv;txt" 0))
    (set_tile "TABLE_CALQUES" f)))

(defun tp:conv-create (/ f)
  (if (setq f (getfiled "Créer la table des calques de ce dessin"
                        (strcat (getvar "DWGPREFIX") (vl-filename-base (getvar "DWGNAME")) " - calques.csv") "csv" 1))
    (if (tp:export-layers f)
      (progn (set_tile "TABLE_CALQUES" f)
             (set_tile "error" "Table créée : complétez la colonne « Calque cible » dans Excel, puis enregistrez."))
      (set_tile "error" "Impossible d'écrire le fichier."))))

(defun tp:sub-conv (/ id)
  (if (setq id (tp:sub-open "tp_conv"))
    (progn
      (set_tile "TABLE_CALQUES" (tp:dlg "TABLE_CALQUES"))
      (action_tile "parcourir" "(tp:conv-browse)")
      (action_tile "creer" "(tp:conv-create)")
      (action_tile "accept" "(tp:dlg-set \"TABLE_CALQUES\" (tp:trim (get_tile \"TABLE_CALQUES\"))) (done_dialog 1)")
      (start_dialog)
      (unload_dialog id))))

(defun tp:help ()
  (alert (strcat
    "Traitement de plans " tp:*version* "\n\n"
    "Coche les opérations, règle les paramètres avec les boutons « ... », puis Lancer.\n"
    "Tout le traitement s'annule d'un seul U.\n\n"
    "Profils : Enregistrer garde les réglages dans le profil choisi ; Enregistrer sous en crée un nouveau.\n"
    "Les profils sont des fichiers .tpp dans le dossier donné par TPDOSSIER (partageable).\n\n"
    "Autres commandes :\n"
    "  TPEXPRESS : profil « Express » sans dialogue\n"
    "  TPPROFIL : lance un profil nommé\n"
    "  TPLOT : traite tous les dessins d'un dossier\n"
    "  TPTABLECALQUES : crée la table CSV des calques à compléter dans Excel\n"
    "  TPCALQUES : applique une table CSV de conversion de calques\n"
    "  TPPURGE, TPLIBERER, TPAPLATIR, TPORIGINE, TPNEXPL : opérations isolées\n\n"
    "Table de calques (CSV, séparateur ;) : Calque source;Calque cible;Couleur;Type de ligne;Epaisseur\n"
    "  * et ? autorisés dans la source ; cible vide = inchangé ; SUPPRIMER = objets supprimés.")))

;; Boîte de dialogue principale ; renvoie la configuration à lancer ou nil.
(defun tp:dialog (/ id st pt)
  (tp:ensure-profiles)
  (setq tp:*profiles* (tp:profile-names) tp:*pname* (tp:last-profile))
  (if (not (member tp:*pname* tp:*profiles*)) (setq tp:*pname* (car tp:*profiles*)))
  (setq tp:*dlg* (tp:profile-load tp:*pname*) st 2 tp:*mesure* nil)
  (setq id (load_dialog (tp:dcl-file)))
  (if (< id 0)
    (progn (alert "Boîte de dialogue introuvable (fichier DCL).") (setq st 0)))
  (while (> st 1)
    (if (not (new_dialog "tp_main" id)) (setq st 0)
      (progn
        (tp:main-init)
        (setq st (start_dialog))
        (cond
          ((= st 5)
           (if (setq pt (getpoint "\nPoint à ramener en 0,0 : "))
             (progn (setq pt (trans pt 1 0))
                    (tp:dlg-set "ORIG_MODE" "COORD") (tp:dlg-set "ORIG_PT" (list (car pt) (cadr pt) 0.0))
                    (tp:dlg-set "ORIGINE" T))))
          ((= st 6) (tp:units-measure))))))
  (if (> id 0) (unload_dialog id))
  (if (= st 1)
    (progn (setenv "TraitementPlans_Dernier" tp:*pname*) tp:*dlg*)))

;;; --------------------------------------------------------------------------
;;; Commandes
;;; --------------------------------------------------------------------------

(defun c:TP (/ cfg)
  (if (setq cfg (tp:dialog)) (tp:cmd cfg))
  (princ))

(defun c:TPEXPRESS ()
  (tp:ensure-profiles)
  (tp:cmd (tp:profile-load "Express")))

(defun c:TPPROFIL (/ p)
  (if (setq p (tp:ask-profile))
    (progn (setenv "TraitementPlans_Dernier" p) (tp:cmd (tp:profile-load p))))
  (princ))

;; Configuration n'exécutant que les opérations données (paramètres du dernier profil).
(defun tp:only (keys / cfg)
  (tp:ensure-profiles)
  (setq cfg (tp:profile-load (tp:last-profile)))
  (foreach k tp:*ops* (setq cfg (tp:cfg-set cfg k (if (member k keys) T nil))))
  cfg)

(defun c:TPPURGE () (tp:cmd (tp:only '("PURGE" "AUDIT"))))
(defun c:TPLIBERER () (tp:cmd (tp:only '("LIBERER"))))
(defun c:TPAPLATIR () (tp:cmd (tp:only '("APLATIR"))))
(defun c:TPNEXPL () (tp:cmd (tp:only '("NEXPL"))))
(defun c:TPORIGINE () (tp:cmd (tp:cfg-set (tp:only '("ORIGINE")) "ORIG_MODE" "POINT")))

(defun c:TPCALQUES (/ f)
  (if (setq f (getfiled "Table de conversion des calques (CSV)" (getvar "DWGPREFIX") "csv;txt" 0))
    (tp:cmd (tp:cfg-set (tp:only '("CONV_CALQUES" "PURGE")) "TABLE_CALQUES" f)))
  (princ))

(defun c:TPTABLECALQUES (/ f)
  (if (setq f (getfiled "Créer la table des calques de ce dessin"
                        (strcat (getvar "DWGPREFIX") (vl-filename-base (getvar "DWGNAME")) " - calques.csv") "csv" 1))
    (if (tp:export-layers f)
      (princ (strcat "\nTable créée : " f "\nComplétez la colonne « Calque cible » dans Excel, puis lancez TPCALQUES."))
      (princ "\nImpossible d'écrire le fichier.")))
  (princ))

(defun c:TPDOSSIER (/ s)
  (princ (strcat "\nDossier actuel des profils : " (tp:dir)))
  (setq s (getstring T "\nNouveau dossier (vide = inchangé, « défaut » = dossier personnel) : "))
  (cond ((= s ""))
        ((= (strcase s) "DÉFAUT") (setenv "TraitementPlans_Dossier" ""))
        (T (setenv "TraitementPlans_Dossier" (vl-string-right-trim "\\/" s)) (tp:ensure-profiles)))
  (princ (strcat "\nDossier des profils : " (tp:dir)))
  (princ))

(defun c:TPAIDE () (tp:help) (princ))

(princ (strcat "\nTraitement de plans " tp:*version* " chargé : TP pour le nettoyeur, TPAIDE pour l'aide."))
(princ)
