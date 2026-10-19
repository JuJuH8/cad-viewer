;; SPDX-License-Identifier: GPL-3.0-or-later
;;; Essai sur un vrai plan : profil « Base architecte » + décomposition des blocs imbriqués.
;;; Affiche le rapport et les comptages avant / après (lignes CV-RES=).

(defun tr:count (/ ss) (if (setq ss (ssget "_X")) (sslength ss) 0))
(defun tr:blocks (/ d n) (setq n 0 d (tblnext "BLOCK" T)) (while d (setq n (1+ n) d (tblnext "BLOCK"))) n)
(defun tr:layers (/ d n) (setq n 0 d (tblnext "LAYER" T)) (while d (setq n (1+ n) d (tblnext "LAYER"))) n)

(princ (strcat "\nCV-RES=avant objets=" (itoa (tr:count)) " blocs=" (itoa (tr:blocks)) " calques=" (itoa (tr:layers))))
(setq tr:cfg (cdr (assoc (if tr:profil tr:profil "Base architecte") (tp:builtin-profiles))))
(setq tr:cfg (tp:cfg-set tr:cfg "NEXPL" T))
(setq tr:r (vl-catch-all-apply 'tp:run (list tr:cfg)))
(if (vl-catch-all-error-p tr:r)
  (princ (strcat "\nCV-RES=ERREUR " (vl-catch-all-error-message tr:r)))
  (foreach l tr:r (princ (strcat "\nCV-RES=" l))))
(princ (strcat "\nCV-RES=après objets=" (itoa (tr:count)) " blocs=" (itoa (tr:blocks)) " calques=" (itoa (tr:layers))))
(princ (strcat "\nCV-RES=commande active=" (itoa (logand 1 (getvar "CMDACTIVE")))))
(princ)
