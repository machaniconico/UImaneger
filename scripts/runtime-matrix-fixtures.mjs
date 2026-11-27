import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectPackageManager, packageInstallPlan } from "../server/lib/package-manager.ts";

async function writeFiles(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

const react = { react: "19.2.3", "react-dom": "19.2.3" };
const react18 = { react: "18.3.1", "react-dom": "18.3.1" };

function nodeApp(name, framework, dependencies, files, { scripts, checkPath } = {}) {
  const installDependencies = Object.keys(dependencies).length > 0;
  return {
    name, framework, runtime: "node", checkPath,
    tools: scripts || installDependencies ? ["node", "npm"] : ["node"],
    async prepare({ root, marker, run, platform = process.platform }) {
      await writeFiles(root, {
        "package.json": JSON.stringify({ private: true, dependencies, scripts }),
        ...files(marker),
      });
      if (!installDependencies) return {};
      const plan = packageInstallPlan(detectPackageManager(root));
      const installArgs = [...plan.args, "--no-audit", "--no-fund", "--loglevel=warn"];
      await run(plan.command, installArgs, { timeoutMs: platform === "win32" ? 600_000 : 300_000 });
      const lsArgs = ["ls", "--depth=0", "--json"];
      const listing = await run("npm", lsArgs, { capture: true });
      if (!listing.trim()) throw new Error(`npm ${lsArgs.join(" ")} returned no stdout`);
      let installed;
      try {
        installed = JSON.parse(listing)?.dependencies;
      } catch (error) {
        throw new Error(`npm ${lsArgs.join(" ")} returned invalid JSON: ${error.message}`, { cause: error });
      }
      if (!installed) throw new Error(`npm ${lsArgs.join(" ")} returned no dependencies`);
      return Object.fromEntries(Object.entries(installed)
        .map(([name, { version }]) => [name, version]));
    },
  };
}

const javaSource = (marker) => `package matrix;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;

@SpringBootApplication
@RestController
public class MatrixApplication {
  public static void main(String[] args) { SpringApplication.run(MatrixApplication.class, args); }
  @GetMapping("/") public String index() { return "${marker}"; }
}
`;
const spring = "3.5.7";

function springApp(builder, files, buildArgs) {
  const name = `Spring Boot (${builder})`;
  const tool = builder === "Maven" ? "mvn" : "gradle";
  return {
    name, framework: name, runtime: "java", tools: ["java", "javac", tool],
    async prepare({ root, marker, run }) {
      await writeFiles(root, {
        ...files,
        "src/main/java/matrix/MatrixApplication.java": javaSource(marker),
        "src/main/resources/application.properties": "server.address=127.0.0.1\n",
      });
      // Download dependencies before the runner's 60-second startup deadline.
      await run(tool, buildArgs);
    },
  };
}

export const fixtures = [
  nodeApp("Static HTML", "Static", {}, (marker) => ({
    "index.html": `<!doctype html><p>${marker}</p>`,
  })),
  nodeApp("Node dev script", "node", {}, (marker) => ({
    "server.cjs": `const http = require('node:http');
const server = http.createServer((_, res) => res.end('${marker}'));
server.listen(0, '127.0.0.1', () => console.log('Listening on ' + server.address().port));
`,
  }), { scripts: { dev: "node server.cjs" } }),
  nodeApp("Vite + React", "Vite", { ...react, vite: "7.3.1", "@vitejs/plugin-react": "5.1.2" }, (marker) => ({
    "index.html": `<!doctype html><title>${marker}</title><div id="root"></div><script type="module" src="/src.jsx"></script>`,
    "vite.config.mjs": "import react from '@vitejs/plugin-react'; export default { plugins: [react()] };",
    "src.jsx": `import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')).render(<p>${marker}</p>);
`,
  }), { checkPath: "/src.jsx" }),
  nodeApp("Next.js", "Next.js", { ...react, next: "15.5.12" }, (marker) => ({
    "pages/index.jsx": `export default function Page() { return <p>${marker}</p>; }`,
  })),
  nodeApp("Nuxt", "Nuxt", { nuxt: "4.2.2" }, (marker) => ({
    "app/app.vue": `<template><p>${marker}</p></template>`,
  })),
  nodeApp("SvelteKit", "SvelteKit", {
    "@sveltejs/kit": "2.49.1", "@sveltejs/vite-plugin-svelte": "6.2.1",
    svelte: "5.46.0", vite: "7.3.1",
  }, (marker) => ({
    "svelte.config.js": "module.exports = {};",
    "vite.config.mjs": "import { sveltekit } from '@sveltejs/kit/vite'; export default { plugins: [sveltekit()] };",
    "src/app.html": "<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>",
    "src/routes/+page.svelte": `<p>${marker}</p>`,
  })),
  nodeApp("Astro", "Astro", { astro: "5.16.6" }, (marker) => ({
    "src/pages/index.astro": `<!doctype html><p>${marker}</p>`,
  })),
  nodeApp("React Router", "React Router", {
    ...react, "react-router": "7.12.0", "@react-router/dev": "7.12.0",
    "@react-router/node": "7.12.0", vite: "6.4.1",
  }, (marker) => ({
    "vite.config.mjs": "import { reactRouter } from '@react-router/dev/vite'; export default { plugins: [reactRouter()] };",
    "app/routes.js": "export default [{ index: true, file: './index.jsx' }];",
    "app/root.jsx": "import { Outlet } from 'react-router'; export default function Root() { return <Outlet />; }",
    "app/index.jsx": `export default function Page() { return <p>${marker}</p>; }`,
  })),
  nodeApp("Remix", "Remix", {
    ...react18, "@remix-run/dev": "2.17.2", "@remix-run/node": "2.17.2",
    "@remix-run/react": "2.17.2", vite: "6.4.1",
  }, (marker) => ({
    "vite.config.mjs": "import { vitePlugin as remix } from '@remix-run/dev'; export default { plugins: [remix()] };",
    "app/root.jsx": "import { Outlet } from '@remix-run/react'; export default function Root() { return <Outlet />; }",
    "app/routes/_index.jsx": `export default function Page() { return <p>${marker}</p>; }`,
  })),
  nodeApp("Angular", "Angular", {
    "@angular/cli": "20.3.15", "@angular-devkit/build-angular": "20.3.15",
    "@angular/core": "20.3.15", "@angular/common": "20.3.15", "@angular/compiler": "20.3.15",
    "@angular/compiler-cli": "20.3.15", "@angular/platform-browser": "20.3.15",
    rxjs: "7.8.2", typescript: "5.9.3", "zone.js": "0.15.1",
  }, (marker) => ({
    "angular.json": JSON.stringify({
      version: 1,
      cli: { analytics: false },
      projects: {
        matrix: {
          root: "", projectType: "application",
          architect: {
            build: {
              builder: "@angular-devkit/build-angular:application",
              options: {
                browser: "src/main.ts", index: "src/index.html", tsConfig: "tsconfig.json",
                outputPath: "dist", polyfills: ["zone.js"], optimization: false,
              },
            },
            serve: {
              builder: "@angular-devkit/build-angular:dev-server",
              options: { buildTarget: "matrix:build" },
            },
          },
        },
      },
    }),
    "tsconfig.json": JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ES2022", moduleResolution: "bundler", experimentalDecorators: true,
    } }),
    "src/index.html": `<!doctype html><title>${marker}</title><matrix-root></matrix-root>`,
    "src/main.ts": `import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
@Component({ selector: 'matrix-root', template: '<p>${marker}</p>' })
class App {}
bootstrapApplication(App);
`,
  }), { checkPath: "/main.js" }),
  nodeApp("Vue CLI", "Vue CLI", { "@vue/cli-service": "5.0.9", vue: "3.5.26" }, (marker) => ({
    "public/index.html": `<!doctype html><title>${marker}</title><div id="app"></div>`,
    "src/main.js": `import { createApp, h } from 'vue'; createApp({ render: () => h('p', '${marker}') }).mount('#app');`,
  }), { checkPath: "/js/app.js" }),
  nodeApp("Create React App", "Create React App", { ...react18, "react-scripts": "5.0.1" }, (marker) => ({
    "public/index.html": `<!doctype html><title>${marker}</title><div id="root"></div>`,
    "src/index.js": `import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')).render(<p>${marker}</p>);
`,
    ".browserslistrc": "defaults\n",
  }), { checkPath: "/static/js/bundle.js" }),
  {
    name: "Django", framework: "Django", runtime: "python", tools: ["python"],
    async prepare({ root, marker, run, versions }) {
      const python = versions.python.command;
      await run(python, ["-m", "venv", "--without-pip", ".venv"]);
      const bin = join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin");
      const venvPython = join(bin, process.platform === "win32" ? "python.exe" : "python");
      await run(python, [
        "-m", "pip", "--python", venvPython, "install", "--no-cache-dir",
        "--disable-pip-version-check", "Django==5.2.13",
      ]);
      await writeFiles(root, {
        "manage.py": `import os, sys
from django.core.management import execute_from_command_line
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "settings")
execute_from_command_line(sys.argv)
`,
        "settings.py": `from django.http import HttpResponse
from django.urls import path
SECRET_KEY = "runtime-matrix-fixture"
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
ROOT_URLCONF = __name__
urlpatterns = [path("", lambda request: HttpResponse("${marker}"))]
`,
      });
      const freeze = await run(python, ["-m", "pip", "--python", venvPython, "freeze"], { capture: true });
      return Object.fromEntries(freeze.trim().split(/\r?\n/).map((line) => line.split("==")));
    },
  },
  {
    name: "PHP (index.php)", framework: "PHP", runtime: "php", tools: ["php"],
    prepare: ({ root, marker }) => writeFiles(root, { "index.php": `<?php echo '${marker}';` }),
  },
  {
    name: "Laravel", framework: "Laravel", runtime: "php", tools: ["php", "composer"],
    async prepare({ root, marker, run, env }) {
      env.COMPOSER_HOME = join(dirname(root), "composer");
      await run("composer", [
        "create-project", "--no-interaction", "--no-scripts", "--no-dev",
        "--prefer-dist", "laravel/laravel", ".", "12.0.0",
      ]);
      env.APP_ENV = "local";
      env.APP_KEY = `base64:${randomBytes(32).toString("base64")}`;
      env.SESSION_DRIVER = "array";
      await writeFiles(root, {
        "routes/web.php": `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/', fn () => '${marker}');
`,
      });
    },
  },
  {
    name: "Go", framework: "Go", runtime: "go", tools: ["go"],
    async prepare({ root, marker, run }) {
      await writeFiles(root, {
        "go.mod": "module example.com/matrix\n\ngo 1.22\n",
        "main.go": `package main
import ("fmt"; "log"; "net"; "net/http"; "os")
func main() {
  ln, err := net.Listen("tcp", "127.0.0.1:" + os.Getenv("PORT"))
  if err != nil { log.Fatal(err) }
  log.Printf("Listening on %s", ln.Addr())
  log.Fatal(http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprint(w, "${marker}")
  })))
}
`,
      });
      await run("go", ["build", "-o", "matrix-app", "."]);
    },
  },
  springApp("Maven", {
    "pom.xml": `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>${spring}</version></parent>
  <groupId>matrix</groupId><artifactId>matrix-app</artifactId><version>1.0.0</version>
  <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
</project>`,
  }, ["--batch-mode", "package"]),
  springApp("Gradle", {
    "settings.gradle": "rootProject.name = 'matrix-app'\n",
    "gradle.properties": "org.gradle.daemon=false\n",
    "build.gradle": `plugins {
  id 'java'
  id 'org.springframework.boot' version '${spring}'
}
repositories { mavenCentral() }
dependencies { implementation 'org.springframework.boot:spring-boot-starter-web:${spring}' }
`,
  }, ["--console=plain", "bootJar"]),
  {
    name: "ASP.NET Core", framework: "ASP.NET Core", runtime: "dotnet", tools: ["dotnet"],
    async prepare({ root, marker, run, env }) {
      env.DOTNET_CLI_TELEMETRY_OPTOUT = "1";
      await writeFiles(root, {
        "global.json": JSON.stringify({ sdk: { version: "10.0.100", rollForward: "latestFeature" } }),
        "Matrix.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
        "Program.cs": `var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/", () => "${marker}");
app.Run();
`,
      });
      await run("dotnet", ["restore", "--nologo"]);
    },
  },
  {
    name: "Rails", framework: "Rails", runtime: "ruby", tools: ["ruby", "gem"],
    async prepare({ root, marker, run, env }) {
      env.GEM_HOME = join(root, ".gems");
      env.GEM_PATH = env.GEM_HOME;
      await run("gem", ["install", "--no-document", "rails:8.0.4", "puma:6.6.1"]);
      await writeFiles(root, {
        Gemfile: 'source "https://rubygems.org"\ngem "rails", "8.0.4"\ngem "puma", "6.6.1"\n',
        "bin/rails": 'APP_PATH = File.expand_path("../config/application", __dir__)\nrequire "rails/commands"\n',
        "config/application.rb": `require "rails"
require "action_controller/railtie"
require "puma"
class MatrixApp < Rails::Application
  config.eager_load = false
  config.secret_key_base = "runtime-matrix-fixture"
  config.hosts << "127.0.0.1"
end
`,
        "config/environment.rb": 'require_relative "application"\nRails.application.initialize!\n',
        "config/routes.rb": `Rails.application.routes.draw do
  get "/", to: ->(_env) { [200, { "content-type" => "text/plain" }, ["${marker}"]] }
end
`,
        "config.ru": 'require_relative "config/environment"\nrun Rails.application\n',
      });
    },
  },
  {
    name: "Phoenix", framework: "Phoenix", runtime: "elixir", tools: ["mix"],
    async prepare({ root, marker, run, env }) {
      env.MIX_HOME = join(root, ".mix");
      env.HEX_HOME = join(root, ".hex");
      await writeFiles(root, {
        "mix.exs": `defmodule Matrix.MixProject do
  use Mix.Project
  def project, do: [app: :matrix, version: "0.1.0", deps: deps()]
  def application, do: [mod: {Matrix.Application, []}, extra_applications: [:logger]]
  defp deps, do: [{:phoenix, "== 1.7.21"}, {:plug_cowboy, "== 2.7.5"}]
end
`,
        "config/config.exs": `import Config
config :matrix, Matrix.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: {:system, "PORT"}],
  secret_key_base: String.duplicate("x", 64)
`,
        "lib/matrix.ex": `defmodule Matrix.Application do
  use Application
  def start(_, _), do: Supervisor.start_link([Matrix.Endpoint], strategy: :one_for_one)
end

# Plug は Endpoint のコンパイル時に Matrix.Page.init/1 を呼ぶため、Page を先に定義する。
defmodule Matrix.Page do
  def init(opts), do: opts
  def call(conn, _opts), do: Plug.Conn.send_resp(conn, 200, "${marker}")
end

defmodule Matrix.Endpoint do
  use Phoenix.Endpoint, otp_app: :matrix
  plug Matrix.Page
end
`,
      });
      await run("mix", ["local.hex", "--force"]);
      await run("mix", ["local.rebar", "--force"]);
      await run("mix", ["deps.get"]);
      await run("mix", ["compile"]);
    },
  },
];
