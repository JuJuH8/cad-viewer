@echo off
rem Démarre le serveur local de CAD Viewer et ouvre l'application dans le navigateur.
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Python est introuvable : installez-le depuis https://www.python.org/ & pause & exit /b 1)
start "" http://localhost:8000/
echo CAD Viewer : http://localhost:8000/  (fermez cette fenêtre pour arrêter le serveur)
python serve.py 8000
