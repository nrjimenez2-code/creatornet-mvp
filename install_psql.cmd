@echo off
:: Installs PostgreSQL 16 command line tools via Chocolatey
choco install postgresql16 --params "/Password:postgres" -y
