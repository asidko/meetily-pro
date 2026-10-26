import os.path

app = defines["app"]
app_name = os.path.basename(app)

files = [app]
symlinks = {"Applications": "/Applications"}
icon = defines["icon"]
background = defines["background"]
format = "UDZO"

window_rect = ((200, 120), (600, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
icon_size = 128
text_size = 16
icon_locations = {app_name: (166, 162), "Applications": (434, 162)}
