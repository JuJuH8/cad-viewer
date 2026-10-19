// SPDX-License-Identifier: GPL-3.0-or-later
// Boîtes de dialogue de « Traitement de plans » (intégrées au .lsp par build.py)

tp_opt : toggle { width = 36; }
tp_btn : button { label = "..."; width = 5; fixed_width = true; }

tp_main : dialog {
  label = "Traitement de plans - Nettoyeur de plan";
  : row {
    : popup_list { key = "profil"; label = "Profil"; width = 40; }
    : button { key = "p_save"; label = "Enregistrer"; fixed_width = true; }
    : button { key = "p_saveas"; label = "Enregistrer sous..."; fixed_width = true; }
    : button { key = "p_del"; label = "Supprimer"; fixed_width = true; }
  }
  : row {
    : column {
      : boxed_column {
        label = "Préparation";
        : tp_opt { key = "LIBERER"; label = "Libérer tous les calques"; }
        : row { : tp_opt { key = "UNITES"; label = "Unités du dessin et conversion"; } : tp_btn { key = "b_UNITES"; } }
        : row { : tp_opt { key = "ORIGINE"; label = "Ramener un point en 0,0"; } : tp_btn { key = "b_ORIGINE"; } }
        : tp_opt { key = "APLATIR"; label = "Tout aplatir (Z = 0, épaisseur 0)"; }
      }
      : boxed_column {
        label = "Suppressions";
        : tp_opt { key = "PRESENTATIONS"; label = "Présentations"; }
        : tp_opt { key = "TEXTES"; label = "Textes vides et espaces superflus"; }
        : row { : tp_opt { key = "PETITS"; label = "Objets de longueur nulle ou trop petits"; } : tp_btn { key = "b_PETITS"; } }
        : tp_opt { key = "MASQUES"; label = "Masques (wipeouts)"; }
        : tp_opt { key = "HACH_SOLIDES"; label = "Hachures pleines (SOLID)"; }
        : tp_opt { key = "SOLIDES2D"; label = "Solides 2D"; }
        : tp_opt { key = "PROXY"; label = "Objets AEC et proxy"; }
        : row { : tp_opt { key = "XREFS"; label = "Xrefs et images introuvables"; } : tp_btn { key = "b_XREFS"; } }
        : tp_opt { key = "GROUPES"; label = "Groupes vides"; }
        : tp_opt { key = "BLOCS_VIDES"; label = "Blocs vides"; }
        : row { : tp_opt { key = "CALQUES_SUPPR"; label = "Calques à supprimer (avec leurs objets)"; } : tp_btn { key = "b_CALQUES_SUPPR"; } }
        : tp_opt { key = "CALQUES_CACHES"; label = "Calques gelés et désactivés (avec leurs objets)"; }
      }
    }
    : column {
      : boxed_column {
        label = "Normalisation";
        : tp_opt { key = "DUCALQUE"; label = "Couleurs DuCalque (objets)"; }
        : tp_opt { key = "DUBLOC"; label = "Couleurs DuBloc (composants des blocs)"; }
        : tp_opt { key = "COTES_DUBLOC"; label = "Couleurs DuBloc (cotes)"; }
        : tp_opt { key = "TL_DUCALQUE"; label = "Types de ligne DuCalque"; }
        : tp_opt { key = "EP_DUCALQUE"; label = "Épaisseurs de ligne DuCalque"; }
        : row { : tp_opt { key = "COULEURS"; label = "Convertir les couleurs"; } : tp_btn { key = "b_COULEURS"; } }
        : row { : tp_opt { key = "COULEUR_UNIQUE"; label = "Couleur unique"; } : tp_btn { key = "b_COULEUR_UNIQUE"; } }
        : row { : tp_opt { key = "TYPESLIGNE"; label = "Convertir les types de ligne"; } : tp_btn { key = "b_TYPESLIGNE"; } }
        : row { : tp_opt { key = "STYLES"; label = "Fusionner les styles de texte"; } : tp_btn { key = "b_STYLES"; } }
        : tp_opt { key = "MTEXT"; label = "Textes multilignes sans mise en forme"; }
        : row { : tp_opt { key = "COTES_CALQUE"; label = "Cotes sur un calque unique"; } : tp_btn { key = "b_COTES_CALQUE"; } }
        : tp_opt { key = "HACH_CALQUE"; label = "Hachures sur un calque unique"; }
        : tp_opt { key = "HACH_ARRIERE"; label = "Hachures en arrière-plan"; }
        : tp_opt { key = "VERR_ARRIERE"; label = "Calques verrouillés en arrière-plan"; }
        : tp_opt { key = "NEXPL"; label = "Décomposer les blocs imbriqués"; }
      }
      : boxed_column {
        label = "Calques et finition";
        : row { : tp_opt { key = "CONV_CALQUES"; label = "Convertir les calques (table CSV)"; } : tp_btn { key = "b_CONV_CALQUES"; } }
        : tp_opt { key = "PURGE"; label = "Tout purger (éléments imbriqués)"; }
        : tp_opt { key = "ECHELLES"; label = "Liste d'échelles normalisée"; }
        : tp_opt { key = "AUDIT"; label = "Contrôler et réparer (AUDIT)"; }
      }
    }
  }
  : boxed_row {
    label = "Traiter aussi les objets des calques";
    : toggle { key = "VERROUILLES"; label = "verrouillés"; }
    : toggle { key = "GELES"; label = "gelés"; }
    : toggle { key = "DESACTIVES"; label = "désactivés"; }
  }
  errtile;
  : row {
    : button { key = "tout"; label = "Tout cocher"; fixed_width = true; }
    : button { key = "rien"; label = "Tout décocher"; fixed_width = true; }
    : button { key = "aide"; label = "Aide"; fixed_width = true; }
    : spacer { width = 6; }
    : button { key = "accept"; label = "Lancer"; is_default = true; fixed_width = true; width = 14; }
    : button { key = "cancel"; label = "Annuler"; is_cancel = true; fixed_width = true; width = 14; }
  }
}

tp_name : dialog {
  label = "Traitement de plans";
  : text { key = "titre"; width = 40; }
  : edit_box { key = "nom"; edit_width = 40; edit_limit = 80; }
  ok_cancel;
}

tp_confirm : dialog {
  label = "Traitement de plans";
  : text { key = "msg"; width = 50; }
  ok_cancel;
}

tp_units : dialog {
  label = "Unités du dessin";
  : text { key = "actuelle"; width = 50; }
  : popup_list { key = "UNITE"; label = "Unité du dessin"; edit_width = 24; }
  : popup_list { key = "PREC"; label = "Décimales affichées"; edit_width = 24; }
  : boxed_column {
    label = "Mise à l'échelle";
    : toggle { key = "CONVUNITE"; label = "Mettre le dessin à l'échelle depuis l'unité :"; }
    : popup_list { key = "UNITE_SRC"; edit_width = 40; }
    : text { label = "Exemple : base en centimètres et unité mm = dessin agrandi 10 fois."; }
  }
  : row {
    : button { key = "mesurer"; label = "Mesurer une distance <"; fixed_width = true; }
    : text { key = "mesure"; width = 40; }
  }
  ok_cancel;
}

tp_origin : dialog {
  label = "Ramener un point en 0,0";
  : radio_column {
    key = "ORIG_MODE";
    : radio_button { key = "POINT"; label = "Désigner le point au lancement"; }
    : radio_button { key = "COORD"; label = "Utiliser les coordonnées ci-dessous (traitement par lot)"; }
  }
  : row {
    : edit_box { key = "X"; label = "X"; edit_width = 16; }
    : edit_box { key = "Y"; label = "Y"; edit_width = 16; }
  }
  : button { key = "pick"; label = "Désigner maintenant <"; fixed_width = true; }
  ok_cancel;
}

tp_small : dialog {
  label = "Objets trop petits";
  : text { label = "Les lignes, arcs, cercles, polylignes, ellipses et splines plus courts"; }
  : text { label = "que cette longueur sont supprimés (0 = seulement les longueurs nulles)."; }
  : edit_box { key = "TOL"; label = "Longueur minimale (unités du dessin)"; edit_width = 14; }
  ok_cancel;
}

tp_xrefs : dialog {
  label = "Xrefs et images";
  : boxed_radio_column {
    key = "XREF_MODE";
    label = "Références externes (DWG)";
    : radio_button { key = "X_INTROUVABLES"; label = "Détacher les xrefs introuvables"; }
    : radio_button { key = "X_NONREF"; label = "Détacher les introuvables et les non référencées"; }
    : radio_button { key = "X_TOUTES"; label = "Détacher toutes les xrefs"; }
    : radio_button { key = "X_LIER"; label = "Lier (insérer) les xrefs trouvées, détacher les introuvables"; }
    : radio_button { key = "X_AUCUNE"; label = "Ne pas toucher aux xrefs"; }
  }
  : boxed_radio_column {
    key = "IMAGE_MODE";
    label = "Images raster";
    : radio_button { key = "I_INTROUVABLES"; label = "Détacher les images introuvables"; }
    : radio_button { key = "I_NONREF"; label = "Détacher les introuvables et les non référencées"; }
    : radio_button { key = "I_TOUTES"; label = "Détacher toutes les images"; }
    : radio_button { key = "I_AUCUNE"; label = "Ne pas toucher aux images"; }
  }
  ok_cancel;
}

tp_laydel : dialog {
  label = "Calques à supprimer";
  : row {
    : column {
      : list_box { key = "filtres"; label = "Calques ou motifs supprimés (* et ? autorisés)"; width = 40; height = 14; }
      : row {
        : edit_box { key = "motif"; edit_width = 24; }
        : button { key = "ajouter_motif"; label = "Ajouter"; fixed_width = true; }
      }
      : button { key = "retirer"; label = "Retirer le motif sélectionné"; fixed_width = true; }
    }
    : column {
      : list_box { key = "calques"; label = "Calques du dessin"; width = 40; height = 14; multiple_select = true; }
      : button { key = "ajouter_calques"; label = "<< Ajouter les calques sélectionnés"; fixed_width = true; }
    }
  }
  : text { label = "Les objets de ces calques sont supprimés partout, blocs compris (sauf calques 0 et DEFPOINTS)."; }
  ok_cancel;
}

tp_colors : dialog {
  label = "Convertir les couleurs";
  : list_box { key = "table"; label = "Conversions (source -> cible)"; width = 40; height = 10; }
  : row {
    : edit_box { key = "src"; label = "Source"; edit_width = 5; }
    : tp_btn { key = "src_ch"; }
    : edit_box { key = "dst"; label = "Cible"; edit_width = 5; }
    : tp_btn { key = "dst_ch"; }
  }
  : row {
    : button { key = "ajouter"; label = "Ajouter"; fixed_width = true; }
    : button { key = "retirer"; label = "Retirer"; fixed_width = true; }
  }
  : text { label = "Source 256 = toutes les couleurs."; }
  : boxed_column {
    label = "Appliquer";
    : toggle { key = "COUL_CALQUES"; label = "aux couleurs des calques"; }
    : toggle { key = "COUL_FORCEES"; label = "aux objets en couleur forcée"; }
    : toggle { key = "COUL_DUCALQUE"; label = "aux objets DuCalque (couleur forcée d'après leur calque)"; }
  }
  errtile;
  ok_cancel;
}

tp_single : dialog {
  label = "Couleur unique";
  : row {
    : edit_box { key = "COUL_UNIQUE"; label = "Couleur"; edit_width = 5; }
    : button { key = "choisir"; label = "Choisir..."; fixed_width = true; }
  }
  : toggle { key = "CU_CALQUES"; label = "Appliquer à tous les calques"; }
  : toggle { key = "CU_ENTITES"; label = "Forcer la couleur de tous les objets (composants des blocs DuBloc)"; }
  errtile;
  ok_cancel;
}

tp_ltypes : dialog {
  label = "Convertir les types de ligne";
  : list_box { key = "table"; label = "Conversions (source -> cible)"; width = 50; height = 10; }
  : row {
    : popup_list { key = "src"; label = "Source"; edit_width = 20; }
    : edit_box { key = "dst"; label = "Cible"; edit_width = 16; }
  }
  : row {
    : button { key = "ajouter"; label = "Ajouter"; fixed_width = true; }
    : button { key = "retirer"; label = "Retirer"; fixed_width = true; }
  }
  : row {
    : edit_box { key = "FICHIER_LIN"; label = "Fichier .lin des types cibles"; edit_width = 30; }
    : button { key = "parcourir"; label = "Parcourir..."; fixed_width = true; }
  }
  : toggle { key = "TL_ECHELLE1"; label = "Échelle de type de ligne 1 pour tous les objets"; }
  ok_cancel;
}

tp_styles : dialog {
  label = "Fusionner les styles de texte";
  : list_box { key = "styles"; label = "Styles du dessin"; width = 40; height = 8; }
  : edit_box { key = "STYLE_NOM"; label = "Style attribué à tous les textes"; edit_width = 24; }
  : edit_box { key = "POLICE"; label = "Police de tous les styles (vide = inchangée)"; edit_width = 24; }
  : text { label = "Exemples de police : arial.ttf, isocp.shx, romans.shx"; }
  errtile;
  ok_cancel;
}

tp_laynames : dialog {
  label = "Calques des cotes et des hachures";
  : edit_box { key = "NOM_COTES"; label = "Calque des cotes"; edit_width = 36; }
  : edit_box { key = "NOM_HACH"; label = "Calque des hachures"; edit_width = 36; }
  errtile;
  ok_cancel;
}

tp_conv : dialog {
  label = "Convertir les calques";
  : text { label = "Table CSV (séparateur ;) : Calque source;Calque cible;Couleur;Type de ligne;Epaisseur"; }
  : text { label = "* et ? autorisés dans la source ; cible vide = inchangé ; SUPPRIMER = objets supprimés."; }
  : row {
    : edit_box { key = "TABLE_CALQUES"; label = "Table"; edit_width = 50; edit_limit = 260; }
    : button { key = "parcourir"; label = "Parcourir..."; fixed_width = true; }
  }
  : button { key = "creer"; label = "Créer la table à partir des calques de ce dessin..."; fixed_width = true; }
  errtile;
  ok_cancel;
}
