# Makefile para compilar arquivos .po para .mo durante o build

# Diretório raiz do projeto
PROJECT_DIR = $(shell pwd)

# Diretório para armazenar os arquivos .po
PO_DIR = ${PROJECT_DIR}/po

UUID = monitor-display-switcher@matheus.com

# Diretório para armazenar os arquivos .mo compilados
LOCALE_DIR = ${PROJECT_DIR}/${UUID}/locale

# Lista de idiomas baseada nos arquivos .po presentes
LANGUAGES = $(patsubst ${PO_DIR}/%.po,%,$(wildcard ${PO_DIR}/*.po))

EXTENSION = extension.js

all: compile_po_files

compile_po_files: create_directories ${foreach lang,${LANGUAGES},compile_po_${lang}}

create_directories:
	mkdir -p ${LOCALE_DIR} ${foreach lang,${LANGUAGES},${LOCALE_DIR}/${lang}/LC_MESSAGES}

define compile_po_rule
compile_po_$1: ${LOCALE_DIR}/$1/LC_MESSAGES/monitordisplay.mo

${LOCALE_DIR}/$1/LC_MESSAGES/monitordisplay.mo: ${PO_DIR}/$1.po
	msgfmt $$< -o $$@
endef

$(foreach lang,${LANGUAGES},$(eval $(call compile_po_rule,$(lang))))

.PHONY: all compile_po_files create_directories ${foreach lang,${LANGUAGES},compile_po_${lang}}

