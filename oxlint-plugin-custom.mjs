/** @type {import("oxlint/plugins-dev").Rule} */
const noUseEffect = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallows using useEffect in .tsx files. Are you sure this needs to be an Effect?",
      url: "https://react.dev/learn/you-might-not-need-an-effect",
    },
    messages: {
      unexpected:
        "Are you sure this needs to be an Effect? See https://react.dev/learn/you-might-not-need-an-effect",
    },
  },
  create(context) {
    const filename = context.filename ?? context.physicalFilename ?? "";
    if (!filename.endsWith(".tsx")) {
      return {};
    }

    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "useEffect") {
          context.report({
            node,
            messageId: "unexpected",
          });
        }
      },
    };
  },
};

const SHARED_MODULE = "unknown-parse.ts";

/** @type {import("oxlint/plugins-dev").Rule} */
const noIsRecord = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        'Disallows local isRecord helpers and inline `typeof x === "object"` object-shape checks. Use the single canonical isRecord from src/unknown-parse.ts, or a domain-typed parser built on it (unknown -> object-shaped -> validate properties -> return a real domain type).',
    },
    messages: {
      localDef:
        "Do not define a local isRecord helper. Import the canonical isRecord from src/unknown-parse.ts instead.",
      bareObjectCheck:
        'Do not inline `typeof x === "object"` for object narrowing. Use isRecord from src/unknown-parse.ts (or a domain-typed parser) so every unknown -> object transition is centralized.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.physicalFilename ?? "";
    if (filename.endsWith(SHARED_MODULE)) {
      return {};
    }

    return {
      FunctionDeclaration(node) {
        if (node.id?.type === "Identifier" && node.id.name === "isRecord") {
          context.report({ node, messageId: "localDef" });
        }
      },
      BinaryExpression(node) {
        if (node.operator !== "===" && node.operator !== "!==") {
          return;
        }
        const leftHasTypeof =
          node.left.type === "UnaryExpression" && node.left.operator === "typeof";
        const rightHasTypeof =
          node.right.type === "UnaryExpression" && node.right.operator === "typeof";
        const leftIsObjectLiteral = node.left.type === "Literal" && node.left.value === "object";
        const rightIsObjectLiteral = node.right.type === "Literal" && node.right.value === "object";
        if ((leftHasTypeof && rightIsObjectLiteral) || (rightHasTypeof && leftIsObjectLiteral)) {
          context.report({ node, messageId: "bareObjectCheck" });
        }
      },
    };
  },
};

export default {
  meta: { name: "custom" },
  rules: {
    "no-use-effect": noUseEffect,
    "no-is-record": noIsRecord,
  },
};
