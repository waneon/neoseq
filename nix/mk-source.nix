{
  lib,
  runCommandLocal,
}:

{
  name,
  root,
  fileset,
}:

let
  rootPrefix = "${toString root}/";
  # Keep local paths file-granular: devenv recursively hashes copied source
  # directories, so copying the repository root also hashes ignored build outputs.
  files = map (path: {
    relativePath = lib.removePrefix rootPrefix (toString path);
    inherit path;
  }) (lib.fileset.toList fileset);
in
runCommandLocal name { } ''
  mkdir -p "$out"
  ${lib.concatMapStringsSep "\n" (
    { path, relativePath }:
    ''
      mkdir -p "$out"/${lib.escapeShellArg (builtins.dirOf relativePath)}
      cp -a ${lib.escapeShellArg "${path}"} "$out"/${lib.escapeShellArg relativePath}
    ''
  ) files}
''
