#/bin/bash
html-minifier-terser --collapse-whitespace \
              --remove-comments \
              --remove-optional-tags \
              --remove-redundant-attributes \
              --remove-script-type-attributes \
              --remove-tag-whitespace \
              --use-short-doctype \
              --minify-css true \
              --minify-js true \
              index.html > index.min.html