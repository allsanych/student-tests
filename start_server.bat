@echo off
color 0A
echo ===================================================
echo     ЗАПУСК СЕРВЕРА СИНХРОНІЗАЦІЇ ТЕСТІВ
echo ===================================================
echo.
echo Підключення до онлайн-сервера на Railway...
set SYNC_MASTER_URL=https://student-tests-production.up.railway.app
node server.js
pause
