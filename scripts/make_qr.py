#!/usr/bin/env python3
"""Regenerate assets/img/qr-site.svg — the QR the site shows when there is no paper card.

    pip3 install qrcode && python3 scripts/make_qr.py [url]

Vector on purpose: the same file prints on the business card at any size.
Error correction Q (25%) so a printed code still reads with a logo, a fold or a scratch.
"""
import io
import pathlib
import sys

import qrcode
import qrcode.image.svg

URL = sys.argv[1] if len(sys.argv) > 1 else "https://yeonguk-choi.github.io"
OUT = pathlib.Path(__file__).resolve().parent.parent / "assets/img/qr-site.svg"

qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_Q, box_size=10, border=4)
qr.add_data(URL)
qr.make(fit=True)

buf = io.BytesIO()
qr.make_image(image_factory=qrcode.image.svg.SvgPathImage).save(buf)
decl, rest = buf.getvalue().decode().split("\n", 1)          # the XML declaration must stay first
note = f"<!-- QR for {URL}. Regenerate with scripts/make_qr.py after changing siteUrl. -->"
OUT.write_text(f"{decl}\n{note}\n{rest}")

print(f"{OUT.name}: version {qr.version}, {len(qr.get_matrix())} modules -> {URL}")
