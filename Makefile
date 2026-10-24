NAME=quake-terminal-sidebar
DOMAIN=ssfxx0923.github.io
EXTENSION_ID=$(NAME)@$(DOMAIN)
PACKED_EXTENSION_FILE=dist/$(EXTENSION_ID).shell-extension.zip

.PHONY: compile pack uninstall install

compile:
	@glib-compile-schemas src/schemas
	@echo "Compiled schemas"

pack:
	@python3 scripts/build.py

uninstall:
	@echo "Uninstalling $(NAME) extension..."
	@if [ -d "$$HOME/.local/share/gnome-shell/extensions/$(EXTENSION_ID)" ]; then \
	echo "Extension $(EXTENSION_ID) found. Proceeding with uninstallation..."; \
	gnome-extensions uninstall "$(EXTENSION_ID)"; \
	rm -rf "$$HOME/.local/share/gnome-shell/extensions/$(EXTENSION_ID)"; \
	echo "Done uninstalling."; \
	else \
	echo "Extension $(EXTENSION_ID) not installed. Nothing to do."; \
	fi

install: pack
	@python3 scripts/install-local.py "$(PACKED_EXTENSION_FILE)"
