; Instalador do awikabot para Windows, feito com o Inno Setup 6.
;
; Quem roda este roteiro e o empacotar.ps1, que passa a versao, a pasta com os arquivos e a
; pasta de saida. Os textos deste arquivo vao sem acento: o Inno Setup le arquivo sem BOM como
; ANSI.
;
; O que o instalador faz: instala so para o usuario, sem pedir administrador, em
; %LOCALAPPDATA%\Programs\awikabot; cria o atalho do Menu Iniciar com a identidade do app, para
; o aviso do sistema sair com o nome e o icone dele. Nao mexe em PATH, inicializacao do Windows,
; firewall nem servicos.
;
; O que a desinstalacao faz: confere se o app esta aberto e pede para fecha-lo; chama o app para
; esvaziar o cofre de credenciais; tira os arquivos, o atalho e o registro da identidade.

#ifndef Versao
  #error Informe a versao: /DVersao=x.y.z
#endif
#ifndef Origem
  #error Informe a pasta com os arquivos do pacote: /DOrigem=...
#endif
#ifndef Saida
  #error Informe a pasta de saida: /DSaida=...
#endif

; A identidade do app para o Windows, a mesma de IDENTIDADE em crates/app/src/janela.rs.
#define Identidade "awikabot.desktop"

[Setup]
; Fixo para sempre: e por ele que uma versao nova reconhece a instalada.
AppId={{AB471C1B-1030-437C-B84B-2CBEDD0EC6C8}
AppName=awikabot
AppVersion={#Versao}
AppVerName=awikabot {#Versao}
AppPublisher=awikabot
DefaultDirName={localappdata}\Programs\awikabot
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#Saida}
OutputBaseFilename=awikabot-{#Versao}-windows-x64
SetupIconFile=..\..\crates\app\recursos\awikabot.ico
UninstallDisplayIcon={app}\awikabot.exe
UninstallDisplayName=awikabot
VersionInfoVersion={#Versao}.0
VersionInfoProductName=awikabot
VersionInfoProductTextVersion={#Versao}
VersionInfoDescription=Instalador do awikabot
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ShowLanguageDialog=no
; Numa atualizacao, o instalador pede ao app aberto para fechar antes de trocar o executavel.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "{#Origem}\awikabot.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Origem}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Origem}\LICENCAS-DE-TERCEIROS.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\awikabot"; Filename: "{app}\awikabot.exe"; AppUserModelID: "{#Identidade}"

[Registry]
; O app grava esta chave ao mostrar o primeiro aviso do sistema; ela sai com a desinstalacao.
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\{#Identidade}"; Flags: dontcreatekey uninsdeletekey

[Run]
; Na instalacao comum, a pessoa escolhe abrir o app no fim.
Filename: "{app}\awikabot.exe"; Description: "{cm:LaunchProgram,awikabot}"; Flags: nowait postinstall skipifsilent
; Na atualizacao pedida pelo proprio app, que roda em silencio com /REABRIR=1, o app volta sozinho.
Filename: "{app}\awikabot.exe"; Flags: nowait; Check: DeveReabrir

[UninstallRun]
; Sem isto, o token deste computador ficaria no cofre do Windows depois de o app ir embora.
Filename: "{app}\awikabot.exe"; Parameters: "--esquecer-sessao"; RunOnceId: "EsquecerSessao"; Flags: runhidden

[Code]
function DeveReabrir: Boolean;
begin
  Result := WizardSilent and (ExpandConstant('{param:REABRIR|0}') = '1');
end;

// Com o app aberto o Windows nao deixa apagar o executavel, e a desinstalacao ficaria pela
// metade. O app cria um objeto com o nome da identidade enquanto esta aberto.
function InitializeUninstall: Boolean;
begin
  Result := True;
  while CheckForMutexes('{#Identidade}') do
  begin
    if UninstallSilent then
    begin
      Result := False;
      Exit;
    end;
    if MsgBox('O awikabot esta aberto. Feche o app e escolha OK para continuar a desinstalacao.', mbInformation, MB_OKCANCEL) <> IDOK then
    begin
      Result := False;
      Exit;
    end;
  end;
end;
